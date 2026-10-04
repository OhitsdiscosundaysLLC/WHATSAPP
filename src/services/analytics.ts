import type { SupabaseClient } from '@supabase/supabase-js';
import { GroupsRepository } from '../db/groupsRepository';
import { computeMetrics, METRIC_IDS, type MetricValue } from './metrics';

export interface DailyCount {
  /** YYYY-MM-DD, UTC calendar day. */
  date: string;
  value: number;
}

export interface TopGroup {
  groupId: string;
  subject: string;
  messageCount: number;
}

export interface AnalyticsResult {
  accountId: string;
  rangeStart: string;
  rangeEnd: string;
  /** Every metric over the whole range — same definitions as the Daily Owner Summary, just a wider window. Never fabricated: each is a direct count against a stored table. */
  totals: MetricValue[];
  /** Messages received per UTC calendar day — real data for a simple trend chart, capped to keep the day-by-day query count bounded. */
  messagesReceivedByDay: DailyCount[];
  /** Rules fired per UTC calendar day. */
  rulesFiredByDay: DailyCount[];
  /** The 5 most active groups by messages received in range. */
  topGroups: TopGroup[];
  /** Total AI tokens actually billed, from whatsapp_ai_usage — never an invented dollar estimate (no pricing table exists to make that honest). */
  aiTokensUsed: { promptTokens: number; completionTokens: number };
}

/** Longer ranges are still computed, but the per-day series is capped here to bound query count (1 query per metric per day). */
const MAX_SERIES_DAYS = 90;

function utcDayBounds(dateStr: string): { start: string; end: string } {
  return {
    start: `${dateStr}T00:00:00.000Z`,
    end: `${dateStr}T23:59:59.999Z`,
  };
}

function utcDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function dailySeries(
  supabase: SupabaseClient,
  accountId: string,
  metricId: 'messages_received' | 'rules_fired',
  start: Date,
  end: Date,
): Promise<DailyCount[]> {
  const days: DailyCount[] = [];
  const cursor = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()),
  );
  const lastDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  let dayCount = 0;

  while (cursor.getTime() <= lastDay.getTime() && dayCount < MAX_SERIES_DAYS) {
    const dateStr = utcDateString(cursor);
    const { start: dayStart, end: dayEnd } = utcDayBounds(dateStr);
    const [metric] = await computeMetrics(supabase, accountId, [metricId], dayStart, dayEnd);
    days.push({ date: dateStr, value: metric?.value ?? 0 });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    dayCount += 1;
  }
  return days;
}

/** Fetched row-by-row and tallied in memory, not a SQL GROUP BY — this project's query layer (and its test fake) only supports simple filters, and the row cap keeps this bounded even for a very active account. */
async function topGroupsByMessageCount(
  supabase: SupabaseClient,
  accountId: string,
  startIso: string,
  endIso: string,
  limit = 5,
): Promise<TopGroup[]> {
  const { data, error } = await supabase
    .from('whatsapp_messages')
    .select('group_id')
    .eq('account_id', accountId)
    .eq('from_me', false)
    .gte('created_at', startIso)
    .lte('created_at', endIso)
    .limit(10_000);
  if (error) {
    throw new Error(`Failed to load messages for top-groups analytics: ${error.message}`);
  }

  const counts = new Map<string, number>();
  for (const row of (data ?? []) as Array<{ group_id: string | null }>) {
    if (!row.group_id) continue; // a private-contact message — not a group
    counts.set(row.group_id, (counts.get(row.group_id) ?? 0) + 1);
  }

  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
  if (sorted.length === 0) return [];

  const groupsRepository = new GroupsRepository(supabase);
  const topGroups: TopGroup[] = [];
  for (const [groupId, messageCount] of sorted) {
    const group = await groupsRepository.getById(groupId);
    topGroups.push({ groupId, subject: group?.subject ?? '(deleted group)', messageCount });
  }
  return topGroups;
}

async function sumAiTokens(
  supabase: SupabaseClient,
  accountId: string,
  startIso: string,
  endIso: string,
): Promise<{ promptTokens: number; completionTokens: number }> {
  const { data, error } = await supabase
    .from('whatsapp_ai_usage')
    .select('prompt_tokens, completion_tokens')
    .eq('account_id', accountId)
    .gte('created_at', startIso)
    .lte('created_at', endIso)
    .limit(10_000);
  if (error) {
    throw new Error(`Failed to load AI usage for analytics: ${error.message}`);
  }

  let promptTokens = 0;
  let completionTokens = 0;
  for (const row of (data ?? []) as Array<{
    prompt_tokens: number | null;
    completion_tokens: number | null;
  }>) {
    promptTokens += row.prompt_tokens ?? 0;
    completionTokens += row.completion_tokens ?? 0;
  }
  return { promptTokens, completionTokens };
}

export async function computeAnalytics(
  supabase: SupabaseClient,
  accountId: string,
  rangeStart: Date,
  rangeEnd: Date,
): Promise<AnalyticsResult> {
  const startIso = rangeStart.toISOString();
  const endIso = rangeEnd.toISOString();

  const [totals, messagesReceivedByDay, rulesFiredByDay, topGroups, aiTokensUsed] =
    await Promise.all([
      computeMetrics(supabase, accountId, METRIC_IDS, startIso, endIso),
      dailySeries(supabase, accountId, 'messages_received', rangeStart, rangeEnd),
      dailySeries(supabase, accountId, 'rules_fired', rangeStart, rangeEnd),
      topGroupsByMessageCount(supabase, accountId, startIso, endIso),
      sumAiTokens(supabase, accountId, startIso, endIso),
    ]);

  return {
    accountId,
    rangeStart: startIso,
    rangeEnd: endIso,
    totals,
    messagesReceivedByDay,
    rulesFiredByDay,
    topGroups,
    aiTokensUsed,
  };
}
