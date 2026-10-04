-- Daily Owner Summary: which metrics to include (Phase 8 continuation).
-- The other daily_summary_* columns (enabled/time/timezone/delivery/
-- last_sent_date) were already added in
-- 20261001230000_whatsapp_phase8_full_build.sql — this migration only adds
-- the metric-selection column that was missing from that pass.

alter table public.whatsapp_account_settings
  add column if not exists daily_summary_metrics text[] not null default array[
    'messages_received',
    'messages_sent_by_bot',
    'rules_fired',
    'moderation_actions_taken',
    'ai_calls_made',
    'deleted_messages_detected',
    'call_events_recorded',
    'pending_approvals_created',
    'owner_inbox_items_created'
  ]::text[];
