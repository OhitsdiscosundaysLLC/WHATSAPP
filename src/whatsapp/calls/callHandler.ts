import type { WACallEvent } from '@whiskeysockets/baileys';
import type { Logger } from 'pino';
import type { AccountSettingsRepository } from '../../db/accountSettingsRepository';
import type { AuditRepository } from '../../db/auditRepository';
import type { CallEventsRepository } from '../../db/callEventsRepository';
import type { NotificationCooldownRepository } from '../../db/notificationCooldownRepository';
import type { OwnerInboxRepository } from '../../db/ownerInboxRepository';
import type { MessageSender } from '../../rules/actionEngine';

export interface CallConnection {
  rejectCall(callId: string, callFrom: string): Promise<void>;
}

export interface CallHandlerDeps {
  accountId: string;
  accountSettingsRepository: AccountSettingsRepository;
  callEventsRepository: CallEventsRepository;
  auditRepository: AuditRepository;
  ownerInbox: OwnerInboxRepository;
  notificationCooldowns: NotificationCooldownRepository;
  sender: MessageSender;
  connection: CallConnection;
  ownerJids: string[];
  logger: Logger;
}

/**
 * Handles one Baileys `call` event (Phase 9 foundation). Baileys exposes
 * call signaling only — offer/ringing/reject/accept/timeout/terminate —
 * never audio/video (see docs/DECISIONS.md ADR-001); this bot can never
 * "answer" a call, only detect it and react. A configured response action
 * only ever runs once per call, on the initial `offer` signal — later
 * signals for the same call (`ringing`, `accept`, `reject`, `timeout`,
 * `terminate`) are still recorded for the activity log, but never
 * re-trigger the configured action. Call handling is configured per
 * WhatsApp account, not per group — see
 * src/db/accountSettingsRepository.ts's doc comment for why.
 */
export async function handleCallEvent(call: WACallEvent, deps: CallHandlerDeps): Promise<void> {
  const settings = await deps.accountSettingsRepository.ensure(deps.accountId);

  let actionTaken: string | undefined;

  if (call.status === 'offer') {
    if (!settings.callHandlingEnabled) {
      actionTaken = 'logged';
    } else {
      switch (settings.callResponseAction) {
        case 'AUTO_REJECT':
          // Emergency Pause stops autonomous actions (rejecting the call),
          // but the call is still recorded — pause never reduces visibility,
          // only autonomous behavior. See docs/DECISIONS.md.
          if (settings.automationPaused) {
            actionTaken = 'paused_skip';
            break;
          }
          try {
            await deps.connection.rejectCall(call.id, call.from);
            actionTaken = 'rejected';
          } catch (err) {
            deps.logger.warn({ err, callId: call.id }, 'Failed to auto-reject call');
            actionTaken = 'reject_failed';
          }
          break;

        case 'NOTIFY_OWNER': {
          if (deps.ownerJids.length === 0) {
            actionTaken = 'logged';
            break;
          }
          const allowed = await deps.notificationCooldowns.tryNotify(
            deps.accountId,
            `call:${call.from}`,
          );
          if (allowed) {
            for (const ownerJid of deps.ownerJids) {
              try {
                await deps.sender.sendTextMessage(
                  ownerJid,
                  `Incoming ${call.isVideo ? 'video ' : ''}call from ${call.from}.`,
                );
              } catch (err) {
                deps.logger.warn({ err, ownerJid }, 'Failed to notify owner of incoming call');
              }
            }
            actionTaken = 'notified_owner';
          } else {
            actionTaken = 'logged';
          }
          break;
        }

        case 'SEND_MESSAGE_AFTER':
          if (settings.automationPaused) {
            actionTaken = 'paused_skip';
          } else if (settings.callResponseMessage) {
            try {
              await deps.sender.sendTextMessage(call.from, settings.callResponseMessage);
              actionTaken = 'sent_message';
            } catch (err) {
              deps.logger.warn({ err, callId: call.id }, 'Failed to send post-call message');
              actionTaken = 'send_failed';
            }
          } else {
            actionTaken = 'logged';
          }
          break;

        case 'LOG_ONLY':
        default:
          actionTaken = 'logged';
      }
    }
  }

  await deps.callEventsRepository.record({
    accountId: deps.accountId,
    callerJid: call.from,
    chatJid: call.chatId,
    groupId: undefined, // no per-contact/group resolution for calls yet — see docs/DECISIONS.md
    isGroup: Boolean(call.isGroup),
    isVideo: Boolean(call.isVideo),
    status: call.status,
    actionTaken,
  });

  await deps.auditRepository.recordEvent({
    accountId: deps.accountId,
    groupId: undefined,
    eventType: 'call.received',
    detail: { status: call.status, from: call.from, isVideo: Boolean(call.isVideo), actionTaken },
  });

  // Owner Inbox visibility for every incoming call offer — the bot never
  // "answers" a call (see this file's doc comment), so every offer is
  // effectively a call only the owner can actually respond to.
  if (call.status === 'offer') {
    await deps.ownerInbox.record({
      accountId: deps.accountId,
      category: 'missed_call',
      title: `Incoming ${call.isVideo ? 'video ' : ''}call from ${call.from}`,
      detail: { from: call.from, isVideo: Boolean(call.isVideo), actionTaken },
    });
  }
}
