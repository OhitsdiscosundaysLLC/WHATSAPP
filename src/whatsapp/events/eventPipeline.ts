import type { MessageUpsertType, WAMessage } from '@whiskeysockets/baileys';
import type { Logger } from 'pino';
import type { AuditRepository } from '../../db/auditRepository';
import type { ContactsRepository } from '../../db/contactsRepository';
import type { GroupsRepository } from '../../db/groupsRepository';
import type { IdentityMapRepository } from '../../db/identityMapRepository';
import type { MessagesRepository } from '../../db/messagesRepository';
import type { RuleEngine } from '../../rules/ruleEngine';
import {
  extractRevokedKey,
  handleDeletedMessage,
  handlePrivateDeletedMessage,
  type DeletedMessageHandlerDeps,
  type PrivateDeletedMessageHandlerDeps,
} from '../archive/deletedMessageHandler';
import {
  handleViewOnceMessage,
  isViewOnceMessageType,
  type ViewOnceHandlerDeps,
} from '../archive/viewOnceHandler';
import { tryHandleCommand, type CommandHandlerDeps } from '../commands/commandHandler';
import {
  tryHandlePrivateCommand,
  type PrivateCommandHandlerDeps,
} from '../commands/privateCommandHandler';
import { extractIdentityCandidates, recordIdentityIfKnown } from '../identity/identityResolver';
import { normalizeMessage, type NormalizedMessageEvent } from './messageNormalizer';

export interface EventPipelineDeps {
  accountId: string;
  groupsRepository: GroupsRepository;
  contactsRepository: ContactsRepository;
  messagesRepository: MessagesRepository;
  identityMapRepository: IdentityMapRepository;
  ruleEngine: RuleEngine;
  auditRepository: AuditRepository;
  /** `undefined` only in contexts with no Supabase/account wiring at all — never in production (see accountManager.ts). */
  deletedMessageHandlerDeps: Omit<DeletedMessageHandlerDeps, 'accountId'>;
  privateDeletedMessageHandlerDeps: Omit<PrivateDeletedMessageHandlerDeps, 'accountId'>;
  viewOnceHandlerDeps: Omit<ViewOnceHandlerDeps, 'accountId'>;
  commandHandlerDeps: CommandHandlerDeps;
  privateCommandHandlerDeps: PrivateCommandHandlerDeps;
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
      } else if (event.context === 'private') {
        await handlePrivateDeletedMessage(revokedKey, event.chatJid, {
          accountId: this.deps.accountId,
          ...this.deps.privateDeletedMessageHandlerDeps,
        }).catch((err: unknown) =>
          this.deps.logger.error({ err }, 'Failed to process private deleted-message event'),
        );
      }
      return;
    }

    if (event.context === 'private') {
      await this.handlePrivateMessage(event, waMessage);
      return;
    }

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
      await this.deps.messagesRepository.store(event, { groupId: group.id });
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

  /**
   * DM-side equivalent of the group branch above — private-chat automation
   * is opt-in only (product spec goal 6, docs/SECURITY.md). A contact is
   * discovered lazily on its first message (mirroring group discovery) and
   * always starts with safe-defaults (all-off) settings, so receiving a DM
   * from someone new never starts automating anything for them.
   *
   * `blocked` is a hard, unconditional gate checked before anything else —
   * monitoring, commands, and rule evaluation all stop immediately for a
   * blocked contact, regardless of any other toggle.
   */
  private async handlePrivateMessage(
    event: NormalizedMessageEvent,
    waMessage: WAMessage,
  ): Promise<void> {
    const contact = await this.deps.contactsRepository.upsertDiscoveredContact(
      this.deps.accountId,
      event.chatJid,
      undefined,
    );
    if (contact.blocked) return;

    const settings = await this.deps.contactsRepository.ensureSettings(contact.id);

    if (settings.privateMonitoringEnabled) {
      await this.deps.messagesRepository.store(event, { contactId: contact.id });
    }

    const identityCandidates = extractIdentityCandidates(waMessage, false);
    await recordIdentityIfKnown(
      identityCandidates,
      this.deps.accountId,
      this.deps.identityMapRepository,
    ).catch((err: unknown) =>
      this.deps.logger.warn({ err }, 'Failed to record WhatsApp identity mapping'),
    );

    // Owner/admin DM commands run independent of privateAutoReplyEnabled —
    // see src/whatsapp/commands/privateCommandHandler.ts. Never reachable
    // by anyone but a configured owner/admin sender.
    const handledAsCommand = await tryHandlePrivateCommand(
      event,
      contact,
      identityCandidates,
      this.deps.privateCommandHandlerDeps,
    ).catch((err: unknown) => {
      this.deps.logger.error({ err }, 'Private command handling threw');
      return false;
    });
    if (handledAsCommand) return;

    if (!settings.privateAutoReplyEnabled) return;

    await this.deps.auditRepository.recordEvent({
      accountId: this.deps.accountId,
      groupId: undefined,
      contactId: contact.id,
      eventType: 'message.received',
      detail: { messageType: event.messageType, scope: 'private' },
    });

    await this.deps.ruleEngine.evaluatePrivate(event, contact.id, settings);
  }
}
