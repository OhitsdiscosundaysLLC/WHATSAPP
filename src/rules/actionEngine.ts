import type { ActionConfig } from './ruleConfig';

/**
 * The minimal capability the action engine needs from a WhatsApp
 * connection — deliberately not a dependency on `WhatsAppConnectionManager`
 * itself, so this module stays decoupled from the `whatsapp/` package (the
 * connection manager satisfies this shape via its own `sendTextMessage()`
 * method; see src/whatsapp/connectionManager.ts).
 */
export interface MessageSender {
  sendTextMessage(jid: string, text: string): Promise<void>;
}

export interface ActionContext {
  groupJid: string;
  sender: MessageSender;
  /** WhatsApp JIDs (already `<number>@s.whatsapp.net`) to notify for NOTIFY_OWNER. */
  ownerJids: string[];
}

export interface ActionExecutionResult {
  status: 'success' | 'failed' | 'skipped';
  detail: string | undefined;
}

/**
 * Executes exactly one action. Extensible for later phases (AI response,
 * moderation, archive, warnings, removal, notifications beyond
 * NOTIFY_OWNER) by adding a new `ActionConfig` variant and a new switch
 * case — the rule engine calling this never needs to change.
 *
 * Never sends anything unauthenticated or unauthorized: the only caller is
 * the rule engine, reached exclusively through dashboard-configured rules
 * (create/edit requires an authenticated owner session — see
 * src/web/groupRoutes.ts) evaluated against real WhatsApp events. No HTTP
 * endpoint can trigger a send directly.
 */
export async function executeAction(
  action: ActionConfig,
  context: ActionContext,
): Promise<ActionExecutionResult> {
  switch (action.type) {
    case 'LOG_ONLY':
      return { status: 'success', detail: 'Logged only — no WhatsApp message sent.' };

    case 'SEND_MESSAGE': {
      try {
        await context.sender.sendTextMessage(context.groupJid, action.message);
        return { status: 'success', detail: undefined };
      } catch (err) {
        return { status: 'failed', detail: err instanceof Error ? err.message : String(err) };
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
          failures.push(`${ownerJid}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (failures.length === context.ownerJids.length) {
        return { status: 'failed', detail: failures.join('; ') };
      }
      if (failures.length > 0) {
        return {
          status: 'success',
          detail: `Some owners could not be notified: ${failures.join('; ')}`,
        };
      }
      return { status: 'success', detail: undefined };
    }
  }
}
