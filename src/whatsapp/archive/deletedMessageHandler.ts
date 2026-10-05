import { proto, type WAMessage } from '@whiskeysockets/baileys';
import type { Logger } from 'pino';
import type { AuditRepository } from '../../db/auditRepository';
import type { ContactsRepository } from '../../db/contactsRepository';
import type { GroupsRepository } from '../../db/groupsRepository';
import type { MediaArchiveRepository } from '../../db/mediaArchiveRepository';
import type { MessagesRepository } from '../../db/messagesRepository';
import type { NotificationCooldownRepository } from '../../db/notificationCooldownRepository';
import type { OwnerInboxRepository } from '../../db/ownerInboxRepository';
import type { MessageSender } from '../../rules/actionEngine';

export interface RevokedMessageKey {
  remoteJid: string;
  id: string;
  participant: string | undefined;
  /** Whether the ORIGINAL (now-revoked) message was sent by this account — not who issued the revoke. */
  fromMe: boolean;
}

/**
 * Detects WhatsApp's "delete for everyone" signal — a `protocolMessage`
 * with `type === REVOKE`, carrying the original message's key. This is
 * the ONLY message deletion WhatsApp ever transmits to other
 * participants/devices; "delete for me" is purely local to the deleting
 * device and never reaches this bot at all (see docs/DECISIONS.md
 * ADR-001 — do not conflate the two or claim "delete for me" support).
 * `REVOKE` is a legitimate cross-user protocol message type (verified
 * against the installed @whiskeysockets/baileys 6.7.24 source,
 * `lib/Utils/process-message.js` — it is explicitly NOT in that file's
 * self-only-type guard), so it is processed the same way any other
 * incoming message is: through the normal `messages.upsert` → idempotency
 * gate path, not a separate unauthenticated channel.
 */
export function extractRevokedKey(waMessage: WAMessage): RevokedMessageKey | undefined {
  const protocolMessage = waMessage.message?.protocolMessage;
  if (!protocolMessage || protocolMessage.type !== proto.Message.ProtocolMessage.Type.REVOKE) {
    return undefined;
  }
  const key = protocolMessage.key;
  if (!key?.id || !key.remoteJid) return undefined;
  return {
    remoteJid: key.remoteJid,
    id: key.id,
    participant: key.participant ?? undefined,
    fromMe: Boolean(key.fromMe),
  };
}

export interface DeletedMessageHandlerDeps {
  accountId: string;
  groupsRepository: GroupsRepository;
  messagesRepository: MessagesRepository;
  mediaArchiveRepository: MediaArchiveRepository;
  auditRepository: AuditRepository;
  ownerInbox: OwnerInboxRepository;
  notificationCooldowns: NotificationCooldownRepository;
  sender: MessageSender;
  ownerJids: string[];
  logger: Logger;
}

/**
 * Handles one detected revocation: marks the original message deleted
 * (if it was ever stored — only possible when `monitoring_enabled` was on
 * at the time), audits it, and optionally notifies the owner (cooldown-
 * protected — "must have cooldown/dedup protection, do not spam the
 * owner", product spec Part H). Group-scoped only in this phase, matching
 * the rest of the product's group-vs-private boundary; a revoked DM
 * message is detected by Baileys the same way but this handler is only
 * ever invoked for `context === 'group'` events (see
 * src/whatsapp/events/eventPipeline.ts).
 */
export async function handleDeletedMessage(
  revokedKey: RevokedMessageKey,
  groupJid: string,
  deps: DeletedMessageHandlerDeps,
): Promise<void> {
  const group = await deps.groupsRepository.getByJid(deps.accountId, groupJid);
  if (!group) return;

  const settings = await deps.groupsRepository.ensureSettings(group.id);
  // The opt-in gate protects OTHER people's deletions (a privacy-sensitive
  // capability); the owner's own self-sent content is always recoverable
  // regardless — mirrors the unconditional self-sent storage/archival in
  // src/whatsapp/events/eventPipeline.ts's handleSelfSentMessage().
  if (!settings.deletedMessageArchiveEnabled && !revokedKey.fromMe) return;

  const found = await deps.messagesRepository.markDeleted(
    deps.accountId,
    revokedKey.remoteJid,
    revokedKey.id,
  );
  // Media (view-once or general) is archived independently, at the time
  // the message first arrived — this is a read-only lookup to tell the
  // owner it's still viewable, never a new archive write.
  const archivedMedia = await deps.mediaArchiveRepository.findByMessageId(
    deps.accountId,
    revokedKey.id,
  );

  await deps.auditRepository.recordEvent({
    accountId: deps.accountId,
    groupId: group.id,
    eventType: 'message.deleted',
    detail: {
      whatsappMessageId: revokedKey.id,
      senderJid: revokedKey.participant,
      archived: found,
      hasArchivedMedia: Boolean(archivedMedia),
    },
  });

  // `deleted_message_alert_mode` controls where the owner is told, never
  // whether the deletion itself is detected/archived (that already
  // happened above, unconditionally) — see docs/SECURITY.md.
  const alertMode = settings.deletedMessageAlertMode;
  const mediaNote = archivedMedia ? ' Its media was archived and can still be viewed.' : '';

  if (alertMode === 'dashboard' || alertMode === 'both') {
    await deps.ownerInbox.record({
      accountId: deps.accountId,
      groupId: group.id,
      category: 'deleted_message',
      title: `A message was deleted in "${group.subject}"`,
      detail: {
        whatsappMessageId: revokedKey.id,
        senderJid: revokedKey.participant,
        archived: found,
        hasArchivedMedia: Boolean(archivedMedia),
      },
    });
  }

  if (alertMode !== 'whatsapp' && alertMode !== 'both') return;
  if (deps.ownerJids.length === 0) return;
  const allowed = await deps.notificationCooldowns.tryNotify(
    deps.accountId,
    `deleted_message:${group.id}`,
  );
  if (!allowed) return;

  for (const ownerJid of deps.ownerJids) {
    try {
      await deps.sender.sendTextMessage(
        ownerJid,
        `A message was deleted in "${group.subject}".${found ? mediaNote : ' (not archived — monitoring was off when it was sent)'}`,
      );
    } catch (err) {
      deps.logger.warn({ err, ownerJid }, 'Failed to notify owner of deleted message');
    }
  }
}

export interface PrivateDeletedMessageHandlerDeps {
  accountId: string;
  contactsRepository: ContactsRepository;
  messagesRepository: MessagesRepository;
  mediaArchiveRepository: MediaArchiveRepository;
  auditRepository: AuditRepository;
  ownerInbox: OwnerInboxRepository;
  notificationCooldowns: NotificationCooldownRepository;
  sender: MessageSender;
  ownerJids: string[];
  logger: Logger;
}

/**
 * DM-side equivalent of `handleDeletedMessage` — same REVOKE detection,
 * same opt-in gate (`private_deleted_message_archive_enabled` instead of
 * `deleted_message_archive_enabled`), same cooldown-protected owner
 * notification, just scoped to a contact instead of a group.
 */
export async function handlePrivateDeletedMessage(
  revokedKey: RevokedMessageKey,
  contactJid: string,
  deps: PrivateDeletedMessageHandlerDeps,
): Promise<void> {
  const contact = await deps.contactsRepository.getByJid(deps.accountId, contactJid);
  if (!contact) return;

  const settings = await deps.contactsRepository.ensureSettings(contact.id);
  // Same self-sent exception as handleDeletedMessage() above.
  if (!settings.privateDeletedMessageArchiveEnabled && !revokedKey.fromMe) return;

  const found = await deps.messagesRepository.markDeleted(
    deps.accountId,
    revokedKey.remoteJid,
    revokedKey.id,
  );
  const archivedMedia = await deps.mediaArchiveRepository.findByMessageId(
    deps.accountId,
    revokedKey.id,
  );

  await deps.auditRepository.recordEvent({
    accountId: deps.accountId,
    groupId: undefined,
    contactId: contact.id,
    eventType: 'message.deleted',
    detail: {
      whatsappMessageId: revokedKey.id,
      senderJid: revokedKey.participant,
      archived: found,
      hasArchivedMedia: Boolean(archivedMedia),
    },
  });

  const alertMode = settings.deletedMessageAlertMode;
  const label = contact.displayName || contact.whatsappJid;
  const mediaNote = archivedMedia ? ' Its media was archived and can still be viewed.' : '';

  if (alertMode === 'dashboard' || alertMode === 'both') {
    await deps.ownerInbox.record({
      accountId: deps.accountId,
      contactId: contact.id,
      category: 'deleted_message',
      title: `A private message was deleted in a chat with "${label}"`,
      detail: {
        whatsappMessageId: revokedKey.id,
        senderJid: revokedKey.participant,
        archived: found,
        hasArchivedMedia: Boolean(archivedMedia),
      },
    });
  }

  if (alertMode !== 'whatsapp' && alertMode !== 'both') return;
  if (deps.ownerJids.length === 0) return;
  const allowed = await deps.notificationCooldowns.tryNotify(
    deps.accountId,
    `deleted_message:contact:${contact.id}`,
  );
  if (!allowed) return;

  for (const ownerJid of deps.ownerJids) {
    try {
      await deps.sender.sendTextMessage(
        ownerJid,
        `A private message was deleted in a chat with "${label}".${found ? mediaNote : ' (not archived — monitoring was off when it was sent)'}`,
      );
    } catch (err) {
      deps.logger.warn({ err, ownerJid }, 'Failed to notify owner of deleted private message');
    }
  }
}
