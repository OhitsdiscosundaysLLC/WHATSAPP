import type { ModerationActionConfig } from '../ruleConfig';
import type { MessageSender } from '../actionEngine';

/** Mirrors the fields of Baileys' `WAMessageKey` this module actually needs. */
export interface MessageKey {
  remoteJid: string;
  id: string;
  participant: string | undefined;
  fromMe: boolean;
}

/**
 * The WhatsApp-admin-only capabilities moderation's destructive actions
 * need, beyond plain `MessageSender.sendTextMessage()` — kept as its own
 * small interface (implemented by `WhatsAppConnectionManager`) rather than
 * widening `MessageSender` itself, so the already-tested Phase 5 action
 * engine (`src/rules/actionEngine.ts`) and its `SEND_MESSAGE`/`LOG_ONLY`/
 * `NOTIFY_OWNER` contract stay completely unchanged.
 */
export interface ModerationCapabilities {
  deleteMessage(key: MessageKey): Promise<void>;
  removeParticipant(groupJid: string, participantJid: string): Promise<void>;
}

export interface ModerationActionContext {
  groupJid: string;
  sender: MessageSender;
  moderation: ModerationCapabilities;
  ownerJids: string[];
  /** group_settings.moderation_destructive_actions_enabled — gates DELETE_MESSAGE/REMOVE_USER only. */
  destructiveActionsEnabled: boolean;
  targetMessageKey: MessageKey | undefined;
  targetSenderJid: string | undefined;
}

export interface ModerationActionResult {
  status: 'success' | 'failed' | 'skipped';
  detail: string | undefined;
}

/**
 * Executes exactly one moderation action. `DELETE_MESSAGE`/`REMOVE_USER`
 * require the connected WhatsApp account to actually hold group-admin
 * permissions — WhatsApp itself enforces that server-side; a failure here
 * (e.g. the bot isn't an admin) surfaces as `status: 'failed'`, never a
 * silent no-op, so it shows up in the audit log and the dashboard.
 * "Never silently remove people" (product spec Part G) is enforced twice:
 * once by `destructiveActionsEnabled` (an explicit, separate per-group
 * toggle — never implied by `moderation_enabled` alone) and once by every
 * outcome being audited by the caller (`src/rules/ruleEngine.ts`).
 */
export async function executeModerationAction(
  action: ModerationActionConfig,
  context: ModerationActionContext,
): Promise<ModerationActionResult> {
  switch (action.type) {
    case 'LOG_ONLY':
      return { status: 'success', detail: 'Logged only — no action taken.' };

    case 'WARN': {
      try {
        await context.sender.sendTextMessage(context.groupJid, action.message);
        return { status: 'success', detail: undefined };
      } catch (err) {
        return { status: 'failed', detail: errorMessage(err) };
      }
    }

    case 'NOTIFY_OWNER': {
      if (context.ownerJids.length === 0) {
        return {
          status: 'skipped',
          detail: 'No OWNER_WHATSAPP_NUMBERS configured — nothing to notify.',
        };
      }
      const failures: string[] = [];
      for (const ownerJid of context.ownerJids) {
        try {
          await context.sender.sendTextMessage(ownerJid, action.message);
        } catch (err) {
          failures.push(`${ownerJid}: ${errorMessage(err)}`);
        }
      }
      if (failures.length === context.ownerJids.length) {
        return { status: 'failed', detail: failures.join('; ') };
      }
      return {
        status: 'success',
        detail:
          failures.length > 0
            ? `Some owners could not be notified: ${failures.join('; ')}`
            : undefined,
      };
    }

    case 'DELETE_MESSAGE': {
      if (!context.destructiveActionsEnabled) {
        return {
          status: 'skipped',
          detail: 'Destructive moderation actions are disabled for this group.',
        };
      }
      if (!context.targetMessageKey) {
        return { status: 'skipped', detail: 'No target message to delete.' };
      }
      try {
        await context.moderation.deleteMessage(context.targetMessageKey);
        return { status: 'success', detail: undefined };
      } catch (err) {
        return { status: 'failed', detail: errorMessage(err) };
      }
    }

    case 'REMOVE_USER': {
      if (!context.destructiveActionsEnabled) {
        return {
          status: 'skipped',
          detail: 'Destructive moderation actions are disabled for this group.',
        };
      }
      if (!context.targetSenderJid) {
        return { status: 'skipped', detail: 'No target participant to remove.' };
      }
      try {
        await context.moderation.removeParticipant(context.groupJid, context.targetSenderJid);
        return { status: 'success', detail: undefined };
      } catch (err) {
        return { status: 'failed', detail: errorMessage(err) };
      }
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
