-- Phase 8: contact/group tags (VIP/never-automate), escalation rules,
-- quiet hours/schedules, human takeover, approval-before-send, group
-- presets, daily owner summary, general (non-view-once) media archive for
-- private contacts too, and configurable deleted-message alert modes.
--
-- Same conventions as every prior migration: additive only, RLS enabled
-- with no anon/authenticated policies (service-role-only access),
-- `created_at`/`updated_at` set by application code, ids generated
-- client-side. Checked against information_schema for collisions before
-- being applied.

-- ---------------------------------------------------------------------
-- group_settings: tags, quiet hours, human takeover, approval, media
-- archive, deleted-message alert mode
-- ---------------------------------------------------------------------

alter table public.group_settings
  add column if not exists vip boolean not null default false,
  add column if not exists never_auto_reply boolean not null default false,
  add column if not exists never_moderate boolean not null default false,
  add column if not exists owner_notes text,
  add column if not exists quiet_hours_enabled boolean not null default false,
  add column if not exists quiet_hours_timezone text,
  add column if not exists quiet_hours_days smallint[] not null default '{}',
  add column if not exists quiet_hours_start_minutes smallint,
  add column if not exists quiet_hours_end_minutes smallint,
  add column if not exists human_takeover_until timestamptz,
  add column if not exists approval_required boolean not null default false,
  add column if not exists media_archive_enabled boolean not null default false,
  add column if not exists deleted_message_alert_mode text not null default 'archive_only';

-- ---------------------------------------------------------------------
-- contact_settings: the same new columns, identical names (no `private_`
-- prefix — these are new concepts, not pre-existing group fields renamed
-- for contacts, so there's no naming collision to avoid; same precedent
-- as dry_run_enabled from the previous migration).
-- ---------------------------------------------------------------------

alter table public.contact_settings
  add column if not exists vip boolean not null default false,
  add column if not exists never_auto_reply boolean not null default false,
  add column if not exists never_moderate boolean not null default false,
  add column if not exists owner_notes text,
  add column if not exists quiet_hours_enabled boolean not null default false,
  add column if not exists quiet_hours_timezone text,
  add column if not exists quiet_hours_days smallint[] not null default '{}',
  add column if not exists quiet_hours_start_minutes smallint,
  add column if not exists quiet_hours_end_minutes smallint,
  add column if not exists human_takeover_until timestamptz,
  add column if not exists approval_required boolean not null default false,
  add column if not exists media_archive_enabled boolean not null default false,
  add column if not exists deleted_message_alert_mode text not null default 'archive_only';

-- ---------------------------------------------------------------------
-- whatsapp_account_settings: Daily Owner Summary (account-wide, same
-- reasoning as call handling and Emergency Pause — these metrics are
-- aggregated across every group/contact under one account, not scoped to
-- a single group).
-- ---------------------------------------------------------------------

alter table public.whatsapp_account_settings
  add column if not exists daily_summary_enabled boolean not null default false,
  add column if not exists daily_summary_time_minutes smallint not null default 540,
  add column if not exists daily_summary_timezone text not null default 'UTC',
  add column if not exists daily_summary_delivery text not null default 'dashboard',
  add column if not exists daily_summary_last_sent_date date;

-- ---------------------------------------------------------------------
-- whatsapp_media_archive: contact_id for private-chat media archiving
-- (general, not just view-once — see src/whatsapp/archive/mediaArchiveHandler.ts)
-- ---------------------------------------------------------------------

alter table public.whatsapp_media_archive
  add column if not exists contact_id uuid references public.whatsapp_contacts(id) on delete set null;

create index if not exists whatsapp_media_archive_contact_created_idx
  on public.whatsapp_media_archive (contact_id, created_at);

-- Lets the deleted-message handler find an already-archived copy of a
-- revoked message's media by (account, chat, whatsapp_message_id) without
-- a full table scan.
create index if not exists whatsapp_media_archive_message_lookup_idx
  on public.whatsapp_media_archive (account_id, whatsapp_message_id);

-- ---------------------------------------------------------------------
-- pending_approvals (Approval Before Send)
-- ---------------------------------------------------------------------

create table if not exists public.pending_approvals (
  id uuid primary key,
  account_id uuid not null references public.whatsapp_accounts(id) on delete cascade,
  group_id uuid references public.whatsapp_groups(id) on delete cascade,
  contact_id uuid references public.whatsapp_contacts(id) on delete cascade,
  rule_id uuid references public.group_rules(id) on delete set null,
  trigger_whatsapp_message_id text,
  target_chat_jid text not null,
  proposed_message text not null,
  status text not null default 'pending', -- pending | approved | rejected | sent | failed
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  constraint pending_approvals_scope_check check (
    (group_id is not null and contact_id is null) or
    (group_id is null and contact_id is not null)
  )
);

create index if not exists pending_approvals_account_status_idx
  on public.pending_approvals (account_id, status, created_at desc);

alter table public.pending_approvals enable row level security;

-- ---------------------------------------------------------------------
-- group_presets (named, reusable settings bundles)
-- ---------------------------------------------------------------------

create table if not exists public.group_presets (
  id uuid primary key,
  account_id uuid not null references public.whatsapp_accounts(id) on delete cascade,
  name text not null,
  settings jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists group_presets_account_idx on public.group_presets (account_id);

alter table public.group_presets enable row level security;
