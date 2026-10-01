import type { SupabaseClient } from '@supabase/supabase-js';

export type CallResponseAction = 'LOG_ONLY' | 'NOTIFY_OWNER' | 'AUTO_REJECT' | 'SEND_MESSAGE_AFTER';

export interface AccountSettings {
  accountId: string;
  callHandlingEnabled: boolean;
  callResponseAction: CallResponseAction;
  callResponseMessage: string | undefined;
  /** Emergency Pause — stops autonomous outbound automation (rule actions, auto-reply, moderation actions, call auto-responses) while monitoring/archiving and owner notifications keep running. Never blocks the owner's own explicit commands. */
  automationPaused: boolean;
  updatedAt: string;
}

export interface AccountSettingsPatch {
  callHandlingEnabled?: boolean;
  callResponseAction?: CallResponseAction;
  callResponseMessage?: string | undefined;
  automationPaused?: boolean;
}

interface AccountSettingsRow {
  account_id: string;
  call_handling_enabled: boolean;
  call_response_action: CallResponseAction;
  call_response_message: string | null;
  automation_paused: boolean;
  updated_at: string;
}

function fromRow(row: AccountSettingsRow): AccountSettings {
  return {
    accountId: row.account_id,
    callHandlingEnabled: row.call_handling_enabled,
    callResponseAction: row.call_response_action,
    callResponseMessage: row.call_response_message ?? undefined,
    automationPaused: row.automation_paused,
    updatedAt: row.updated_at,
  };
}

/**
 * Call handling is configured per WhatsApp ACCOUNT, not per group — unlike
 * messages, an incoming call is not reliably scoped to a specific
 * monitored group (most real calls are 1:1/DM calls to the account's own
 * number, and there is no per-contact/DM settings model yet). See
 * docs/DECISIONS.md.
 */
export class AccountSettingsRepository {
  constructor(private readonly supabase: SupabaseClient) {}

  async ensure(accountId: string): Promise<AccountSettings> {
    const existing = await this.get(accountId);
    if (existing) return existing;

    const now = new Date().toISOString();
    const row = {
      account_id: accountId,
      call_handling_enabled: false,
      call_response_action: 'LOG_ONLY' as const,
      call_response_message: null,
      automation_paused: false,
      updated_at: now,
    };
    const { error } = await this.supabase
      .from('whatsapp_account_settings')
      .upsert(row, { onConflict: 'account_id' });
    if (error) {
      throw new Error(`Failed to create default account settings: ${error.message}`);
    }
    return fromRow(row as AccountSettingsRow);
  }

  async get(accountId: string): Promise<AccountSettings | undefined> {
    const { data, error } = await this.supabase
      .from('whatsapp_account_settings')
      .select('*')
      .eq('account_id', accountId)
      .maybeSingle();
    if (error) {
      throw new Error(`Failed to load account settings: ${error.message}`);
    }
    return data ? fromRow(data as AccountSettingsRow) : undefined;
  }

  async update(accountId: string, patch: AccountSettingsPatch): Promise<AccountSettings> {
    await this.ensure(accountId);
    const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (patch.callHandlingEnabled !== undefined)
      row.call_handling_enabled = patch.callHandlingEnabled;
    if (patch.callResponseAction !== undefined) row.call_response_action = patch.callResponseAction;
    if (patch.callResponseMessage !== undefined) {
      row.call_response_message = patch.callResponseMessage || null;
    }
    if (patch.automationPaused !== undefined) row.automation_paused = patch.automationPaused;

    const { data, error } = await this.supabase
      .from('whatsapp_account_settings')
      .update(row)
      .eq('account_id', accountId)
      .select('*')
      .maybeSingle();
    if (error || !data) {
      throw new Error(`Failed to update account settings: ${error?.message ?? 'no row returned'}`);
    }
    return fromRow(data as AccountSettingsRow);
  }
}
