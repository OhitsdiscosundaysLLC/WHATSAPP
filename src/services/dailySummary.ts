import type { SupabaseClient } from '@supabase/supabase-js';
import type { Logger } from 'pino';
import { AccountSettingsRepository, type AccountSettings } from '../db/accountSettingsRepository';
import { OwnerInboxRepository } from '../db/ownerInboxRepository';
import { computeMetrics, METRIC_IDS, type MetricValue } from './metrics';

export type SummaryMetricValue = MetricValue;

export interface DailySummaryResult {
  accountId: string;
  /** Local calendar date (YYYY-MM-DD) in the account's configured timezone that this summary covers. */
  localDate: string;
  metrics: SummaryMetricValue[];
}

/** Re-exported for existing callers (src/web/accountRoutes.ts) — see src/services/metrics.ts for the shared definitions. */
export const DAILY_SUMMARY_METRIC_IDS = METRIC_IDS;

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
  const metrics = await computeMetrics(supabase, accountId, metricIds, start, end);

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
