import type { SupabaseClient } from '@supabase/supabase-js';
import type { Logger } from 'pino';
import { AccountSettingsRepository, type AccountSettings } from '../db/accountSettingsRepository';
import { OwnerInboxRepository } from '../db/ownerInboxRepository';

export interface SummaryMetricValue {
  id: string;
  label: string;
  value: number;
}

export interface DailySummaryResult {
  accountId: string;
  /** Local calendar date (YYYY-MM-DD) in the account's configured timezone that this summary covers. */
  localDate: string;
  metrics: SummaryMetricValue[];
}

type CountQuery = {
  eq: (col: string, val: unknown) => CountQuery;
  in: (col: string, vals: unknown[]) => CountQuery;
  gte: (col: string, val: unknown) => CountQuery;
  lte: (col: string, val: unknown) => CountQuery;
} & PromiseLike<{ count: number | null; error: { message: string } | null }>;

async function countRows(
  supabase: SupabaseClient,
  table: string,
  accountId: string,
  dayStartIso: string,
  dayEndIso: string,
  extra?: (q: CountQuery) => CountQuery,
): Promise<number> {
  let query = supabase
    .from(table)
    .select('*', { count: 'exact', head: true })
    .eq('account_id', accountId)
    .gte('created_at', dayStartIso)
    .lte('created_at', dayEndIso) as unknown as CountQuery;
  if (extra) query = extra(query);

  const { count, error } = await query;
  if (error) {
    throw new Error(`Failed to count ${table} for daily summary: ${error.message}`);
  }
  return count ?? 0;
}

/**
 * Every metric is a real, direct count against an existing table — never
 * estimated, derived, or fabricated (same "only real aggregated data"
 * standard as the Analytics dashboard). Keyed by the exact string stored in
 * `whatsapp_account_settings.daily_summary_metrics`.
 */
const METRIC_DEFINITIONS: Record<
  string,
  {
    label: string;
    count: (
      supabase: SupabaseClient,
      accountId: string,
      start: string,
      end: string,
    ) => Promise<number>;
  }
> = {
  messages_received: {
    label: 'Messages received',
    count: (supabase, accountId, start, end) =>
      countRows(supabase, 'whatsapp_messages', accountId, start, end, (q) =>
        q.eq('from_me', false),
      ),
  },
  messages_sent_by_bot: {
    label: 'Messages sent by the bot',
    count: (supabase, accountId, start, end) =>
      countRows(supabase, 'bot_actions', accountId, start, end, (q) =>
        q.in('action_type', ['SEND_MESSAGE', 'AI_REPLY']).eq('status', 'success'),
      ),
  },
  rules_fired: {
    label: 'Rules fired',
    count: (supabase, accountId, start, end) =>
      countRows(supabase, 'whatsapp_audit_logs', accountId, start, end, (q) =>
        q.in('event_type', ['rule.fired', 'escalation.fired']),
      ),
  },
  moderation_actions_taken: {
    label: 'Moderation actions taken',
    count: (supabase, accountId, start, end) =>
      countRows(supabase, 'bot_actions', accountId, start, end, (q) =>
        q.in('action_type', ['WARN', 'DELETE_MESSAGE', 'REMOVE_USER']).eq('status', 'success'),
      ),
  },
  ai_calls_made: {
    label: 'AI calls made',
    count: (supabase, accountId, start, end) =>
      countRows(supabase, 'whatsapp_ai_usage', accountId, start, end),
  },
  deleted_messages_detected: {
    label: 'Deleted messages detected',
    count: (supabase, accountId, start, end) =>
      countRows(supabase, 'whatsapp_audit_logs', accountId, start, end, (q) =>
        q.eq('event_type', 'message.deleted'),
      ),
  },
  call_events_recorded: {
    label: 'Call events recorded',
    count: (supabase, accountId, start, end) =>
      countRows(supabase, 'whatsapp_call_events', accountId, start, end),
  },
  pending_approvals_created: {
    label: 'Replies held for approval',
    count: (supabase, accountId, start, end) =>
      countRows(supabase, 'pending_approvals', accountId, start, end),
  },
  owner_inbox_items_created: {
    label: 'Owner Inbox items',
    count: (supabase, accountId, start, end) =>
      countRows(supabase, 'owner_inbox_items', accountId, start, end),
  },
};

export const DAILY_SUMMARY_METRIC_IDS = Object.keys(METRIC_DEFINITIONS);

function localDateString(date: Date, timezone: string): string {
  // en-CA formats as YYYY-MM-DD, exactly the stored/dedup format.
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(date);
}

/** The [start, end] instants (as ISO strings) covering one full local calendar day in `timezone`. */
function localDayBounds(localDate: string, timezone: string): { start: string; end: string } {
  // Standard offset-probe technique: read what wall-clock date/time
  // `timezone` shows at a guessed UTC instant, re-interpret those same
  // numbers as if they were UTC, and the difference between the two is
  // that zone's offset at that instant — from which the real UTC instant
  // of local midnight falls out. Correct across any DST transition, since
  // it reads the actual IANA tz database via Intl, not a fixed offset.
  const utcGuess = new Date(`${localDate}T00:00:00.000Z`);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(utcGuess);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asIfUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  const offsetMs = asIfUtc - utcGuess.getTime();
  const start = new Date(utcGuess.getTime() - offsetMs);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

export async function computeDailySummary(
  supabase: SupabaseClient,
  accountId: string,
  metricIds: string[],
  timezone: string,
  now: Date = new Date(),
): Promise<DailySummaryResult> {
  const localDate = localDateString(now, timezone);
  const { start, end } = localDayBounds(localDate, timezone);

  const metrics: SummaryMetricValue[] = [];
  for (const id of metricIds) {
    const def = METRIC_DEFINITIONS[id];
    if (!def) continue; // an unrecognized id is skipped, never guessed at
    const value = await def.count(supabase, accountId, start, end);
    metrics.push({ id, label: def.label, value });
  }

  return { accountId, localDate, metrics };
}

export function formatSummaryText(result: DailySummaryResult): string {
  const lines = [`📊 Daily Summary — ${result.localDate}`];
  for (const metric of result.metrics) {
    lines.push(`• ${metric.label}: ${metric.value}`);
  }
  return lines.join('\n');
}

/**
 * Whether `now` (in the account's configured timezone) has reached the
 * configured send time for the first time today — i.e. local time is at or
 * past `timeMinutes` AND today's local date hasn't already been sent.
 * Fails safe (never sends) on an invalid timezone.
 */
function isDueNow(settings: AccountSettings, now: Date): { due: boolean; localDate: string } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: settings.dailySummaryTimezone,
      hourCycle: 'h23',
      hour: 'numeric',
      minute: 'numeric',
    }).formatToParts(now);
  } catch {
    return { due: false, localDate: '' };
  }
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? NaN);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? NaN);
  if (Number.isNaN(hour) || Number.isNaN(minute)) return { due: false, localDate: '' };

  const localDate = localDateString(now, settings.dailySummaryTimezone);
  const minutesNow = hour * 60 + minute;
  const alreadySentToday = settings.dailySummaryLastSentDate === localDate;
  return { due: minutesNow >= settings.dailySummaryTimeMinutes && !alreadySentToday, localDate };
}

export interface DailySummaryDeps {
  supabase: SupabaseClient;
  /** Only called when delivery includes 'whatsapp' — throwing is caught and logged, never lets one account's send failure skip the rest. */
  sendTextMessage: (accountId: string, jid: string, text: string) => Promise<void>;
  ownerJids: string[];
  logger: Logger;
}

/**
 * Checks every account's Daily Owner Summary settings and delivers one for
 * any account whose configured local send time has just passed today (and
 * hasn't already gone out today — see `isDueNow`). Best-effort periodic
 * sweep (same pattern as src/whatsapp/archive/retentionSweep.ts) — a missed
 * tick just means the next one catches up; nothing depends on exact timing
 * beyond "roughly once past the configured time, not before, not twice".
 */
export async function runDailySummarySweep(
  accountIds: string[],
  deps: DailySummaryDeps,
): Promise<void> {
  const accountSettingsRepository = new AccountSettingsRepository(deps.supabase);
  const ownerInbox = new OwnerInboxRepository(deps.supabase);
  const now = new Date();

  for (const accountId of accountIds) {
    try {
      const settings = await accountSettingsRepository.get(accountId);
      if (!settings?.dailySummaryEnabled) continue;

      const { due, localDate } = isDueNow(settings, now);
      if (!due) continue;

      const result = await computeDailySummary(
        deps.supabase,
        accountId,
        settings.dailySummaryMetrics,
        settings.dailySummaryTimezone,
        now,
      );
      const text = formatSummaryText(result);

      if (
        settings.dailySummaryDelivery === 'dashboard' ||
        settings.dailySummaryDelivery === 'both'
      ) {
        await ownerInbox.record({
          accountId,
          category: 'rule_fired',
          title: `Daily Summary — ${result.localDate}`,
          detail: { metrics: result.metrics, kind: 'daily_summary' },
        });
      }
      if (
        settings.dailySummaryDelivery === 'whatsapp' ||
        settings.dailySummaryDelivery === 'both'
      ) {
        for (const ownerJid of deps.ownerJids) {
          try {
            await deps.sendTextMessage(accountId, ownerJid, text);
          } catch (err) {
            deps.logger.warn(
              { err, accountId, ownerJid },
              'Failed to deliver daily summary via WhatsApp',
            );
          }
        }
      }

      // Recorded as the very last step — if anything above throws, the
      // summary is NOT marked sent, so the next sweep tick retries it
      // rather than silently skipping today.
      await accountSettingsRepository.update(accountId, { dailySummaryLastSentDate: localDate });
      deps.logger.info({ accountId, localDate }, 'Delivered daily owner summary');
    } catch (err) {
      deps.logger.warn({ err, accountId }, 'Daily summary sweep failed for account');
    }
  }
}

/** Starts the periodic sweep. Returns a stop function. Safe to call at most once per process. */
export function startDailySummarySweep(
  listAccountIds: () => string[],
  deps: DailySummaryDeps,
  intervalMs = 5 * 60 * 1000, // 5 minutes — summaries are time-of-day sensitive, unlike the 6-hour retention sweep
): () => void {
  const run = () => {
    runDailySummarySweep(listAccountIds(), deps).catch((err: unknown) =>
      deps.logger.error({ err }, 'Daily summary sweep threw unexpectedly'),
    );
  };

  run();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
