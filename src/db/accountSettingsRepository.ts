import type { SupabaseClient } from '@supabase/supabase-js';

export type CallResponseAction = 'LOG_ONLY' | 'NOTIFY_OWNER' | 'AUTO_REJECT' | 'SEND_MESSAGE_AFTER';

export type DailySummaryDelivery = 'dashboard' | 'whatsapp' | 'both';
export const DAILY_SUMMARY_DELIVERIES: DailySummaryDelivery[] = ['dashboard', 'whatsapp', 'both'];

export interface AccountSettings {
  accountId: string;
  callHandlingEnabled: boolean;
  callResponseAction: CallResponseAction;
  callResponseMessage: string | undefined;
  /** Emergency Pause — stops autonomous outbound automation (rule actions, auto-reply, moderation actions, call auto-responses) while monitoring/archiving and owner notifications keep running. Never blocks the owner's own explicit commands. */
  automationPaused: boolean;
  dailySummaryEnabled: boolean;
  /** Minutes since local midnight in dailySummaryTimezone — e.g. 540 = 9:00am. */
  dailySummaryTimeMinutes: number;
  /** IANA timezone name — explicit, never the server/Render timezone (see src/rules/quietHours.ts for the same reasoning). */
  dailySummaryTimezone: string;
  dailySummaryDelivery: DailySummaryDelivery;
  dailySummaryMetrics: string[];
  /** Local date (YYYY-MM-DD, in dailySummaryTimezone) the summary last went out — the dedup gate so one day never sends twice. */
  dailySummaryLastSentDate: string | undefined;
  updatedAt: string;
}

export interface AccountSettingsPatch {
  callHandlingEnabled?: boolean;
  callResponseAction?: CallResponseAction;
  callResponseMessage?: string | undefined;
  automationPaused?: boolean;
  dailySummaryEnabled?: boolean;
  dailySummaryTimeMinutes?: number;
  dailySummaryTimezone?: string;
  dailySummaryDelivery?: DailySummaryDelivery;
  dailySummaryMetrics?: string[];
  dailySummaryLastSentDate?: string | undefined;
}

interface AccountSettingsRow {
  account_id: string;
  call_handling_enabled: boolean;
  call_response_action: CallResponseAction;
  call_response_message: string | null;
  automation_paused: boolean;
  daily_summary_enabled: boolean;
  daily_summary_time_minutes: number;
  daily_summary_timezone: string;
  daily_summary_delivery: DailySummaryDelivery;
  daily_summary_metrics: string[];
  daily_summary_last_sent_date: string | null;
  updated_at: string;
}

function fromRow(row: AccountSettingsRow): AccountSettings {
  return {
    accountId: row.account_id,
    callHandlingEnabled: row.call_handling_enabled,
    callResponseAction: row.call_response_action,
    callResponseMessage: row.call_response_message ?? undefined,
    automationPaused: row.automation_paused,
    dailySummaryEnabled: row.daily_summary_enabled,
    dailySummaryTimeMinutes: row.daily_summary_time_minutes,
    dailySummaryTimezone: row.daily_summary_timezone,
    dailySummaryDelivery: row.daily_summary_delivery,
    dailySummaryMetrics: row.daily_summary_metrics ?? [],
    dailySummaryLastSentDate: row.daily_summary_last_sent_date ?? undefined,
    updatedAt: row.updated_at,
  };
}

export const DEFAULT_DAILY_SUMMARY_METRICS = [
  'messages_received',
  'messages_sent_by_bot',
  'rules_fired',
  'moderation_actions_taken',
  'ai_calls_made',
  'deleted_messages_detected',
  'call_events_recorded',
  'pending_approvals_created',
  'owner_inbox_items_created',
];

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
      daily_summary_enabled: false,
      daily_summary_time_minutes: 540,
      daily_summary_timezone: 'UTC',
      daily_summary_delivery: 'dashboard' as const,
      daily_summary_metrics: DEFAULT_DAILY_SUMMARY_METRICS,
      daily_summary_last_sent_date: null,
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
    if (patch.dailySummaryEnabled !== undefined)
      row.daily_summary_enabled = patch.dailySummaryEnabled;
    if (patch.dailySummaryTimeMinutes !== undefined)
      row.daily_summary_time_minutes = patch.dailySummaryTimeMinutes;
    if (patch.dailySummaryTimezone !== undefined)
      row.daily_summary_timezone = patch.dailySummaryTimezone;
    if (patch.dailySummaryDelivery !== undefined)
      row.daily_summary_delivery = patch.dailySummaryDelivery;
    if (patch.dailySummaryMetrics !== undefined)
      row.daily_summary_metrics = patch.dailySummaryMetrics;
    if (Object.hasOwn(patch, 'dailySummaryLastSentDate')) {
      row.daily_summary_last_sent_date = patch.dailySummaryLastSentDate ?? null;
    }

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
