import type { MessageUpsertType, WAMessage } from '@whiskeysockets/baileys';
import type { Logger } from 'pino';
import type { AccountSettingsRepository } from '../../db/accountSettingsRepository';
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
  DEFAULT_PRIVATE_MEDIA_MAX_FILE_SIZE_BYTES,
  handleGeneralMediaMessage,
  isGeneralMediaMessageType,
  type MediaArchiveHandlerDeps,
} from '../archive/mediaArchiveHandler';
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
  /** Emergency Pause lives here (account-scoped) — checked before any rule evaluation, group or private. */
  accountSettingsRepository: AccountSettingsRepository;
  /** `undefined` only in contexts with no Supabase/account wiring at all — never in production (see accountManager.ts). */
  deletedMessageHandlerDeps: Omit<DeletedMessageHandlerDeps, 'accountId'>;
  privateDeletedMessageHandlerDeps: Omit<PrivateDeletedMessageHandlerDeps, 'accountId'>;
  viewOnceHandlerDeps: Omit<ViewOnceHandlerDeps, 'accountId'>;
  mediaArchiveHandlerDeps: Omit<MediaArchiveHandlerDeps, 'accountId'>;
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

    // WhatsApp's "delete for everyone" signal — a protocolMessage carrying
    // the original message's key, legitimately delivered through the same
    // messages.upsert path as any other message (see
    // src/whatsapp/archive/deletedMessageHandler.ts). Checked BEFORE the
    // `fromMe` branch below: when the owner deletes their OWN sent message
    // "for everyone" (including a message sent from the Owner Media
    // Console — src/web/mediaConsoleRoutes.ts), Baileys delivers that
    // revoke with `fromMe: true` too, and it must still be processed —
    // otherwise self-sent deletions would silently never be archived. See
    // docs/DECISIONS.md on why self-sent content is never excluded here.
    // Never a normal message in its own right — handled and done, nothing
    // else to store or evaluate for it.
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

    // Our own outgoing message (sent from this phone, another linked
    // device, an automated rule, or the Owner Media Console) — Baileys
    // echoes every sent message back through this same `messages.upsert`
    // path with `fromMe: true`. Still stored and media-archived exactly
    // like an incoming message (so it can later be found and shown if the
    // owner deletes it "for everyone" — see the revoke branch above), but
    // never treated as an incoming trigger: no commands, no rule
    // evaluation, no "message.received" audit noise for our own sends.
    if (event.fromMe) {
      await this.handleSelfSentMessage(event, waMessage);
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
        { groupId: group.id, contactId: undefined },
        {
          enabled: settings.viewOnceHandlingEnabled && settings.monitoringEnabled,
          maxFileSizeBytes: settings.mediaMaxFileSizeBytes,
        },
        {
          accountId: this.deps.accountId,
          ...this.deps.viewOnceHandlerDeps,
        },
      ).catch((err: unknown) =>
        this.deps.logger.error({ err }, 'Failed to process view-once media'),
      );
    }

    // General (non-view-once) media archive — opt-in, independent of
    // view-once handling above; a sticker/image/video/audio/document is
    // archived here, a view-once wrapper is archived above, never both for
    // the same message since `event.messageType` can only be one value.
    if (
      settings.mediaArchiveEnabled &&
      settings.monitoringEnabled &&
      isGeneralMediaMessageType(event.messageType)
    ) {
      await handleGeneralMediaMessage(
        waMessage,
        event.whatsappMessageId,
        event.senderJid,
        event.messageType,
        { groupId: group.id, contactId: undefined },
        settings.mediaMaxFileSizeBytes,
        { accountId: this.deps.accountId, ...this.deps.mediaArchiveHandlerDeps },
      ).catch((err: unknown) =>
        this.deps.logger.error({ err }, 'Failed to process general media archive'),
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

    // Emergency Pause — stops autonomous rule/auto-reply/moderation actions
    // while monitoring/storage (already done above) and owner/admin
    // commands (already handled above) keep working. See
    // src/db/accountSettingsRepository.ts.
    const accountSettings = await this.deps.accountSettingsRepository.ensure(this.deps.accountId);
    if (accountSettings.automationPaused) {
      await this.deps.auditRepository.recordEvent({
        accountId: this.deps.accountId,
        groupId: group.id,
        eventType: 'automation.paused_skip',
        detail: { messageType: event.messageType },
      });
      return;
    }

    await this.deps.ruleEngine.evaluate(event, group.id, settings);
  }

  /**
   * "Welcome Message" template's trigger — a new participant was added to a
   * known group (Baileys `group-participants.update`, action `'add'`; see
   * src/whatsapp/connectionManager.ts). Same `bot_enabled`/Emergency Pause
   * gates as `handleMessage()`'s group branch; an unknown group is skipped
   * the same way (discovery will catch up).
   */
  async handleParticipantJoined(groupJid: string, participantJid: string): Promise<void> {
    const group = await this.deps.groupsRepository.getByJid(this.deps.accountId, groupJid);
    if (!group) return;

    const settings = await this.deps.groupsRepository.ensureSettings(group.id);
    if (!settings.botEnabled) return;

    const accountSettings = await this.deps.accountSettingsRepository.ensure(this.deps.accountId);
    if (accountSettings.automationPaused) {
      await this.deps.auditRepository.recordEvent({
        accountId: this.deps.accountId,
        groupId: group.id,
        eventType: 'automation.paused_skip',
        detail: { trigger: 'participant_joined' },
      });
      return;
    }

    await this.deps.ruleEngine.evaluateParticipantJoined(
      group.id,
      groupJid,
      this.deps.accountId,
      participantJid,
      settings,
    );
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

    // View-once media — DM-side equivalent of the group branch above.
    // Contacts have no separate view-once toggle (unlike groups'
    // `view_once_handling_enabled`); `mediaArchiveEnabled` covers both
    // general and view-once content for a private chat.
    if (isViewOnceMessageType(event.messageType)) {
      await handleViewOnceMessage(
        waMessage,
        event.whatsappMessageId,
        event.senderJid,
        { groupId: undefined, contactId: contact.id },
        {
          enabled: settings.mediaArchiveEnabled && settings.privateMonitoringEnabled,
          maxFileSizeBytes: DEFAULT_PRIVATE_MEDIA_MAX_FILE_SIZE_BYTES,
        },
        { accountId: this.deps.accountId, ...this.deps.viewOnceHandlerDeps },
      ).catch((err: unknown) =>
        this.deps.logger.error({ err }, 'Failed to process view-once media'),
      );
    }

    // General (non-view-once) media archive — DM-side equivalent of the
    // group branch above. Private chats have no configurable size-limit
    // field, so this uses the same fixed default every group starts with.
    if (
      settings.mediaArchiveEnabled &&
      settings.privateMonitoringEnabled &&
      isGeneralMediaMessageType(event.messageType)
    ) {
      await handleGeneralMediaMessage(
        waMessage,
        event.whatsappMessageId,
        event.senderJid,
        event.messageType,
        { groupId: undefined, contactId: contact.id },
        DEFAULT_PRIVATE_MEDIA_MAX_FILE_SIZE_BYTES,
        { accountId: this.deps.accountId, ...this.deps.mediaArchiveHandlerDeps },
      ).catch((err: unknown) =>
        this.deps.logger.error({ err }, 'Failed to process general media archive'),
      );
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

    const accountSettings = await this.deps.accountSettingsRepository.ensure(this.deps.accountId);
    if (accountSettings.automationPaused) {
      await this.deps.auditRepository.recordEvent({
        accountId: this.deps.accountId,
        groupId: undefined,
        contactId: contact.id,
        eventType: 'automation.paused_skip',
        detail: { messageType: event.messageType, scope: 'private' },
      });
      return;
    }

    await this.deps.ruleEngine.evaluatePrivate(event, contact.id, settings);
  }

  /**
   * Our own outgoing message, echoed back by Baileys with `fromMe: true`
   * (see `handleMessage()` above for why this is reached before any
   * command/rule-evaluation logic). Always stored and media/view-once
   * archived — unlike the incoming branches, this is NEVER gated behind
   * `monitoringEnabled`/`mediaArchiveEnabled`/`viewOnceHandlingEnabled`:
   * those toggles exist to make surveilling OTHER people's messages
   * opt-in; they have no bearing on the owner's own sent content, which
   * must always be recoverable if later deleted "for everyone" (see the
   * revoke branch in `handleMessage()`, and docs/DECISIONS.md). This is
   * also what makes a manual send from the Owner Media Console
   * (src/web/mediaConsoleRoutes.ts) end up viewable/deletable through the
   * exact same archive used for everything else — no separate code path.
   */
  private async handleSelfSentMessage(
    event: NormalizedMessageEvent,
    waMessage: WAMessage,
  ): Promise<void> {
    let groupId: string | undefined;
    let contactId: string | undefined;

    if (event.context === 'group' && event.groupJid) {
      const group = await this.deps.groupsRepository.getByJid(this.deps.accountId, event.groupJid);
      groupId = group?.id;
    } else {
      contactId = (
        await this.deps.contactsRepository.upsertDiscoveredContact(
          this.deps.accountId,
          event.chatJid,
          undefined,
        )
      ).id;
    }
    if (!groupId && !contactId) return;

    const scope = { groupId, contactId };
    const maxFileSizeBytes = groupId
      ? (await this.deps.groupsRepository.ensureSettings(groupId)).mediaMaxFileSizeBytes
      : DEFAULT_PRIVATE_MEDIA_MAX_FILE_SIZE_BYTES;

    await this.deps.messagesRepository.store(
      event,
      groupId ? { groupId } : { contactId: contactId! },
    );

    if (isViewOnceMessageType(event.messageType)) {
      await handleViewOnceMessage(
        waMessage,
        event.whatsappMessageId,
        event.senderJid,
        scope,
        { enabled: true, maxFileSizeBytes },
        { accountId: this.deps.accountId, ...this.deps.viewOnceHandlerDeps },
      ).catch((err: unknown) =>
        this.deps.logger.error({ err }, 'Failed to process self-sent view-once media'),
      );
    } else if (isGeneralMediaMessageType(event.messageType)) {
      await handleGeneralMediaMessage(
        waMessage,
        event.whatsappMessageId,
        event.senderJid,
        event.messageType,
        scope,
        maxFileSizeBytes,
        { accountId: this.deps.accountId, ...this.deps.mediaArchiveHandlerDeps },
      ).catch((err: unknown) =>
        this.deps.logger.error({ err }, 'Failed to process self-sent media archive'),
      );
    }
  }
}
