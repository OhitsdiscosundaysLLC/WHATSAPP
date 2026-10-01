import type { MessageUpsertType, WAMessage } from '@whiskeysockets/baileys';
import type { Logger } from 'pino';
import type { AuditRepository } from '../../db/auditRepository';
import type { GroupsRepository } from '../../db/groupsRepository';
import type { IdentityMapRepository } from '../../db/identityMapRepository';
import type { MessagesRepository } from '../../db/messagesRepository';
import type { RuleEngine } from '../../rules/ruleEngine';
import {
  extractRevokedKey,
  handleDeletedMessage,
  type DeletedMessageHandlerDeps,
} from '../archive/deletedMessageHandler';
import {
  handleViewOnceMessage,
  isViewOnceMessageType,
  type ViewOnceHandlerDeps,
} from '../archive/viewOnceHandler';
import { tryHandleCommand, type CommandHandlerDeps } from '../commands/commandHandler';
import { extractIdentityCandidates, recordIdentityIfKnown } from '../identity/identityResolver';
import { normalizeMessage } from './messageNormalizer';

export interface EventPipelineDeps {
  accountId: string;
  groupsRepository: GroupsRepository;
  messagesRepository: MessagesRepository;
  identityMapRepository: IdentityMapRepository;
  ruleEngine: RuleEngine;
  auditRepository: AuditRepository;
  /** `undefined` only in contexts with no Supabase/account wiring at all — never in production (see accountManager.ts). */
  deletedMessageHandlerDeps: Omit<DeletedMessageHandlerDeps, 'accountId'>;
  viewOnceHandlerDeps: Omit<ViewOnceHandlerDeps, 'accountId'>;
  commandHandlerDeps: CommandHandlerDeps;
  logger: Logger;
}

/**
 * The production message/event pipeline (Phase 4):
 *
 *   WhatsApp event → normalize → identify context (group/private) →
 *   idempotency gate → permission/configuration lookup (group_settings) →
 *   [optional] store → [optional] rule engine → audit
 *
 * Deliberately does NOT reply to anything just because a message arrived —
 * "the first responsibility is understanding the event and context" (see
 * product spec). Storage only happens when a group's `monitoring_enabled`
 * is true; rule evaluation only happens when `bot_enabled` is true. A
 * newly-discovered group defaults to both off (see
 * src/db/groupsRepository.ts's `DEFAULT_GROUP_SETTINGS`), so nothing
 * automates itself without the owner explicitly opting in.
 */
export class EventPipeline {
  constructor(private readonly deps: EventPipelineDeps) {}

  async handleMessage(waMessage: WAMessage, type: MessageUpsertType): Promise<void> {
    const event = normalizeMessage(this.deps.accountId, waMessage);
    if (!event) return;

    // Always-on idempotency gate, independent of any group's settings —
    // WhatsApp/Baileys can redeliver the same event, and that must never
    // cause double storage or a double rule evaluation.
    const isNew = await this.deps.messagesRepository.markProcessed(event);
    if (!isNew) return;

    // 'append' is Baileys' marker for offline-backlog messages being
    // synced in, not a live event — evaluating rules against a backlog
    // right after reconnect would look like a sudden flood of "new"
    // responses. Only 'notify' (genuinely live) messages proceed further.
    if (type !== 'notify') return;

    // Never treat the bot's own outgoing message as an incoming trigger.
    if (event.fromMe) return;

    // WhatsApp's "delete for everyone" signal — a protocolMessage carrying
    // the original message's key, legitimately delivered through the same
    // messages.upsert path as any other message (see
    // src/whatsapp/archive/deletedMessageHandler.ts). Never a normal
    // message in its own right — handled and done, nothing else to store
    // or evaluate for it.
    const revokedKey = extractRevokedKey(waMessage);
    if (revokedKey) {
      if (event.context === 'group' && event.groupJid) {
        await handleDeletedMessage(revokedKey, event.groupJid, {
          accountId: this.deps.accountId,
          ...this.deps.deletedMessageHandlerDeps,
        }).catch((err: unknown) =>
          this.deps.logger.error({ err }, 'Failed to process deleted-message event'),
        );
      }
      return;
    }

    // Private-chat automation is explicitly out of scope / off by default
    // in this phase (see product spec #6) — normalized and dedup-gated
    // above, but nothing further happens for a private-chat message yet.
    if (event.context !== 'group' || !event.groupJid) return;

    const group = await this.deps.groupsRepository.getByJid(this.deps.accountId, event.groupJid);
    if (!group) {
      // A message from a group we haven't discovered yet (e.g. the very
      // first message right after the bot was added, before the next
      // discovery cycle). Nothing to configure against — skip safely;
      // discovery will catch up via groups.upsert or the next connect.
      this.deps.logger.warn(
        { groupJid: event.groupJid },
        'Message from an undiscovered WhatsApp group; skipping',
      );
      return;
    }

    const settings = await this.deps.groupsRepository.ensureSettings(group.id);

    if (settings.monitoringEnabled) {
      await this.deps.messagesRepository.store(event, group.id);
    }

    if (isViewOnceMessageType(event.messageType)) {
      await handleViewOnceMessage(
        waMessage,
        event.whatsappMessageId,
        event.senderJid,
        group,
        settings,
        {
          accountId: this.deps.accountId,
          ...this.deps.viewOnceHandlerDeps,
        },
      ).catch((err: unknown) =>
        this.deps.logger.error({ err }, 'Failed to process view-once media'),
      );
    }

    // Identity resolution (@lid <-> phone number) — extract whatever forms
    // Baileys attached to this message's sender and opportunistically
    // record the pairing for future lookups, independent of whether this
    // turns out to be a command. See src/whatsapp/identity/identityResolver.ts.
    const identityCandidates = extractIdentityCandidates(waMessage, true);
    await recordIdentityIfKnown(
      identityCandidates,
      this.deps.accountId,
      this.deps.identityMapRepository,
    ).catch((err: unknown) =>
      this.deps.logger.warn({ err }, 'Failed to record WhatsApp identity mapping'),
    );

    // Owner/admin in-chat commands run independent of bot_enabled — ".bot
    // on" must work even while the bot is off (product spec Part C).
    // Never reachable by a non-owner/admin sender — see
    // src/whatsapp/commands/commandHandler.ts.
    const handledAsCommand = await tryHandleCommand(
      event,
      group,
      identityCandidates,
      this.deps.commandHandlerDeps,
    ).catch((err: unknown) => {
      this.deps.logger.error({ err }, 'Command handling threw');
      return false;
    });
    if (handledAsCommand) return;

    if (!settings.botEnabled) return;

    await this.deps.auditRepository.recordEvent({
      accountId: this.deps.accountId,
      groupId: group.id,
      eventType: 'message.received',
      detail: { messageType: event.messageType, hasQuote: Boolean(event.quotedWhatsappMessageId) },
    });

    await this.deps.ruleEngine.evaluate(event, group.id, settings);
  }
}
