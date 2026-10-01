import { proto, type WAMessage } from '@whiskeysockets/baileys';
import type { Logger } from 'pino';
import type { AuditRepository } from '../../db/auditRepository';
import type { GroupsRepository } from '../../db/groupsRepository';
import type { MessagesRepository } from '../../db/messagesRepository';
import type { NotificationCooldownRepository } from '../../db/notificationCooldownRepository';
import type { MessageSender } from '../../rules/actionEngine';

export interface RevokedMessageKey {
  remoteJid: string;
  id: string;
  participant: string | undefined;
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
  return { remoteJid: key.remoteJid, id: key.id, participant: key.participant ?? undefined };
}

export interface DeletedMessageHandlerDeps {
  accountId: string;
  groupsRepository: GroupsRepository;
  messagesRepository: MessagesRepository;
  auditRepository: AuditRepository;
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
  if (!settings.deletedMessageArchiveEnabled) return;

  const found = await deps.messagesRepository.markDeleted(
    deps.accountId,
    revokedKey.remoteJid,
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
    },
  });

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
        `A message was deleted in "${group.subject}".${found ? '' : ' (not archived — monitoring was off when it was sent)'}`,
      );
    } catch (err) {
      deps.logger.warn({ err, ownerJid }, 'Failed to notify owner of deleted message');
    }
  }
}
