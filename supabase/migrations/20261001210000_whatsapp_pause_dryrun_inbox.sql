-- Emergency Pause, Dry Run, and the Owner Inbox — all purely additive.

-- ---------------------------------------------------------------------
-- Emergency Pause: one account-level switch that stops autonomous
-- outbound automation (rule actions, auto-reply, moderation actions,
-- call auto-responses) while monitoring/archiving and owner notifications
-- keep running, and the owner's own explicit commands keep working.
-- Lives alongside the existing call-handling settings (same account-
-- scoped table, same reasoning as docs/DECISIONS.md).
-- ---------------------------------------------------------------------
alter table whatsapp_account_settings add column if not exists automation_paused boolean not null default false;

-- ---------------------------------------------------------------------
-- Dry Run: per-group / per-contact. When on, the rule engine evaluates
-- real events exactly as normal but logs "would have done X" instead of
-- actually executing the action — never a live send/delete/remove.
-- ---------------------------------------------------------------------
alter table group_settings add column if not exists dry_run_enabled boolean not null default false;
alter table contact_settings add column if not exists dry_run_enabled boolean not null default false;

-- ---------------------------------------------------------------------
-- Owner Inbox: a human-readable operations feed, separate from the raw
-- whatsapp_audit_logs/bot_actions tables the Activity page already reads
-- — this is specifically the "things the owner should look at" subset,
-- with read/dismissed state the audit log itself doesn't have.
-- ---------------------------------------------------------------------
create table if not exists owner_inbox_items (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references whatsapp_accounts(id) on delete cascade,
  group_id uuid references whatsapp_groups(id) on delete cascade,
  contact_id uuid references whatsapp_contacts(id) on delete cascade,
  category text not null,
  title text not null,
  detail jsonb,
  read boolean not null default false,
  dismissed boolean not null default false,
  created_at timestamptz not null default now()
);
alter table owner_inbox_items enable row level security;
create index if not exists owner_inbox_items_account_id_idx on owner_inbox_items(account_id);
create index if not exists owner_inbox_items_created_at_idx on owner_inbox_items(created_at desc);
