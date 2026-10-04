import type { SupabaseClient } from '@supabase/supabase-js';

export interface MetricValue {
  id: string;
  label: string;
  value: number;
}

type CountQuery = {
  eq: (col: string, val: unknown) => CountQuery;
  in: (col: string, vals: unknown[]) => CountQuery;
  gte: (col: string, val: unknown) => CountQuery;
  lte: (col: string, val: unknown) => CountQuery;
} & PromiseLike<{ count: number | null; error: { message: string } | null }>;

export async function countRows(
  supabase: SupabaseClient,
  table: string,
  accountId: string,
  startIso: string,
  endIso: string,
  extra?: (q: CountQuery) => CountQuery,
): Promise<number> {
  let query = supabase
    .from(table)
    .select('*', { count: 'exact', head: true })
    .eq('account_id', accountId)
    .gte('created_at', startIso)
    .lte('created_at', endIso) as unknown as CountQuery;
  if (extra) query = extra(query);

  const { count, error } = await query;
  if (error) {
    throw new Error(`Failed to count ${table}: ${error.message}`);
  }
  return count ?? 0;
}

/**
 * Every metric is a real, direct count against an existing table — never
 * estimated, derived, or fabricated. Shared between the Daily Owner
 * Summary (src/services/dailySummary.ts, one calendar day) and the
 * Analytics dashboard (src/services/analytics.ts, an arbitrary date
 * range) — same metric definitions, same underlying queries, just a
 * different [start, end] window. Keyed by the exact string stored in
 * `whatsapp_account_settings.daily_summary_metrics`.
 */
export const METRIC_DEFINITIONS: Record<
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

export const METRIC_IDS = Object.keys(METRIC_DEFINITIONS);

export async function computeMetrics(
  supabase: SupabaseClient,
  accountId: string,
  metricIds: string[],
  startIso: string,
  endIso: string,
): Promise<MetricValue[]> {
  const values: MetricValue[] = [];
  for (const id of metricIds) {
    const def = METRIC_DEFINITIONS[id];
    if (!def) continue; // an unrecognized id is skipped, never guessed at
    const value = await def.count(supabase, accountId, startIso, endIso);
    values.push({ id, label: def.label, value });
  }
  return values;
}
