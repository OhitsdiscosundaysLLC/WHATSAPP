-- Phase 4+5: WhatsApp event pipeline, group configuration, and the
-- deterministic rule engine. Purely additive — does not alter or touch
-- whatsapp_accounts / whatsapp_auth_credentials / whatsapp_auth_keys (Phase
-- 3) or any unrelated table already in this project (e.g. Disco Sundays CRM
-- tables).
--
-- Same conventions as the Phase 3 migration (docs/DECISIONS.md ADR-011):
--   - RLS enabled on every table, zero policies for anon/authenticated —
--     default-deny. Only the service_role key (server-side only) reads or
--     writes these tables.
--   - `updated_at` is set explicitly by application code, not a trigger.
--   - gen_random_uuid() is Postgres core (v13+), no extension needed.
--
-- Table map (see docs/DATABASE.md for full column-level docs):
--   whatsapp_groups            durable group registry (one row per account+group JID)
--   group_settings             1:1 with whatsapp_groups — every automation toggle, safe-default OFF
--   whatsapp_processed_events  always-on idempotency gate (every inbound message, regardless of monitoring)
--   whatsapp_messages          optional message archive (only written when monitoring_enabled)
--   group_rules                rule definitions (JSON config, strictly validated in application code)
--   rule_matches                per (rule, target message) progress + fired state — durable across restarts
--   rule_match_responders      distinct qualifying senders per rule_match — composite PK enforces distinctness
--   rule_cooldowns             last-fired timestamp per rule, for cooldown enforcement
--   bot_actions                what the action engine actually did (or didn't) and why
--   whatsapp_audit_logs        general activity feed for the dashboard's Activity page
--                              (named with a whatsapp_ prefix, not plain audit_logs,
--                              because this project already has an unrelated,
--                              pre-existing audit_logs CRM table — see docs/DECISIONS.md
--                              ADR-012)

-- ---------------------------------------------------------------------
-- whatsapp_groups
-- ---------------------------------------------------------------------
-- Identity is the WhatsApp group JID, never the display name (names can
-- change — see group_rename handling in src/whatsapp/groups/groupDiscovery.ts).
create table if not exists public.whatsapp_groups (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.whatsapp_accounts(id) on delete cascade,
  whatsapp_group_jid text not null,
  subject text not null default '',
  discovered_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, whatsapp_group_jid)
);

comment on table public.whatsapp_groups is
  'Durable WhatsApp group registry (Phase 4), one row per (account, group JID). Identity is the JID, never the display name.';

alter table public.whatsapp_groups enable row level security;

-- ---------------------------------------------------------------------
-- group_settings
-- ---------------------------------------------------------------------
-- 1:1 with whatsapp_groups. Every toggle defaults to false/off — a newly
-- discovered group must never start automating itself (see
-- docs/DECISIONS.md ADR-012). Columns beyond bot/monitoring exist now as
-- configuration architecture for features not yet implemented (AI,
-- auto-reply, archiving, etc.) — the dashboard labels these clearly as
-- "not yet active" rather than pretending they do something.
create table if not exists public.group_settings (
  group_id uuid primary key references public.whatsapp_groups(id) on delete cascade,
  bot_enabled boolean not null default false,
  monitoring_enabled boolean not null default false,
  ai_enabled boolean not null default false,
  auto_reply_enabled boolean not null default false,
  deleted_message_archive_enabled boolean not null default false,
  view_once_handling_enabled boolean not null default false,
  call_handling_enabled boolean not null default false,
  moderation_enabled boolean not null default false,
  custom_group_instructions text,
  custom_ai_instructions text,
  default_cooldown_seconds integer not null default 0 check (default_cooldown_seconds >= 0),
  updated_at timestamptz not null default now()
);

comment on table public.group_settings is
  'Per-group automation toggles (Phase 4). Safe defaults: everything OFF until the owner explicitly enables it via the dashboard.';

alter table public.group_settings enable row level security;

-- ---------------------------------------------------------------------
-- whatsapp_processed_events
-- ---------------------------------------------------------------------
-- Always-on idempotency gate for EVERY inbound message (group or private,
-- monitored or not) — WhatsApp/Baileys can redeliver the same event, and
-- this must never cause a duplicate action. Deliberately separate from
-- whatsapp_messages: this table exists purely for dedup and is written
-- unconditionally; whatsapp_messages is the optional, fuller archive that
-- only exists when a group's monitoring_enabled is true (see docs/DATABASE.md).
create table if not exists public.whatsapp_processed_events (
  account_id uuid not null references public.whatsapp_accounts(id) on delete cascade,
  chat_jid text not null,
  whatsapp_message_id text not null,
  processed_at timestamptz not null default now(),
  primary key (account_id, chat_jid, whatsapp_message_id)
);

comment on table public.whatsapp_processed_events is
  'Idempotency gate for every inbound WhatsApp message, independent of monitoring/storage settings. The composite PK is the dedup mechanism.';

alter table public.whatsapp_processed_events enable row level security;

-- ---------------------------------------------------------------------
-- whatsapp_messages
-- ---------------------------------------------------------------------
-- Normalized message archive, written only for groups with
-- monitoring_enabled = true. Deliberately does not store raw Baileys
-- payloads or media bytes — see docs/DATABASE.md.
create table if not exists public.whatsapp_messages (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.whatsapp_accounts(id) on delete cascade,
  group_id uuid references public.whatsapp_groups(id) on delete cascade,
  chat_jid text not null,
  whatsapp_message_id text not null,
  sender_jid text not null,
  from_me boolean not null default false,
  message_type text not null,
  text_content text,
  quoted_whatsapp_message_id text,
  deleted boolean not null default false,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  unique (account_id, chat_jid, whatsapp_message_id)
);

comment on table public.whatsapp_messages is
  'Optional normalized message archive (Phase 4), written only when a group''s monitoring_enabled is true. Not a raw Baileys payload dump.';

create index if not exists whatsapp_messages_group_created_idx
  on public.whatsapp_messages (group_id, created_at);
create index if not exists whatsapp_messages_quoted_idx
  on public.whatsapp_messages (account_id, chat_jid, quoted_whatsapp_message_id);

alter table public.whatsapp_messages enable row level security;

-- ---------------------------------------------------------------------
-- group_rules
-- ---------------------------------------------------------------------
-- `config` is free-form jsonb at the schema level, but every write and
-- every read-before-execute goes through strict zod validation in
-- application code (src/db/rulesRepository.ts) keyed on trigger_type —
-- the database does not make arbitrary JSON executable.
create table if not exists public.group_rules (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.whatsapp_groups(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  enabled boolean not null default true,
  trigger_type text not null,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.group_rules is
  'Rule definitions scoped to one group (Phase 5). config is strictly zod-validated in application code before every write and execution.';

create index if not exists group_rules_group_idx on public.group_rules (group_id);

alter table public.group_rules enable row level security;

-- ---------------------------------------------------------------------
-- rule_matches
-- ---------------------------------------------------------------------
-- One row per (rule, target WhatsApp message being responded to). This is
-- the durable threshold-progress + fired-state record — a Render restart
-- must not reset progress (see docs/DECISIONS.md ADR-012).
create table if not exists public.rule_matches (
  id uuid primary key default gen_random_uuid(),
  rule_id uuid not null references public.group_rules(id) on delete cascade,
  target_whatsapp_message_id text not null,
  fired boolean not null default false,
  fired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (rule_id, target_whatsapp_message_id)
);

comment on table public.rule_matches is
  'Durable per-(rule, target message) progress and fired-state (Phase 5). Survives process restarts — see src/rules/ruleEngine.ts.';

alter table public.rule_matches enable row level security;

-- ---------------------------------------------------------------------
-- rule_match_responders
-- ---------------------------------------------------------------------
-- The composite primary key is what enforces "N DISTINCT people" at the
-- schema level: a second qualifying response from the same sender for the
-- same rule_match is structurally a no-op (ON CONFLICT DO NOTHING), not an
-- application-level counting exercise that could get out of sync.
create table if not exists public.rule_match_responders (
  rule_match_id uuid not null references public.rule_matches(id) on delete cascade,
  sender_jid text not null,
  whatsapp_message_id text not null,
  responded_at timestamptz not null default now(),
  primary key (rule_match_id, sender_jid)
);

comment on table public.rule_match_responders is
  'Distinct qualifying senders per rule_match (Phase 5). Composite PK (rule_match_id, sender_jid) enforces distinct-sender counting at the schema level.';

alter table public.rule_match_responders enable row level security;

-- ---------------------------------------------------------------------
-- rule_cooldowns
-- ---------------------------------------------------------------------
create table if not exists public.rule_cooldowns (
  rule_id uuid primary key references public.group_rules(id) on delete cascade,
  last_fired_at timestamptz not null
);

comment on table public.rule_cooldowns is
  'Last-fired timestamp per rule (Phase 5), used to enforce configured cooldowns durably across restarts.';

alter table public.rule_cooldowns enable row level security;

-- ---------------------------------------------------------------------
-- bot_actions
-- ---------------------------------------------------------------------
create table if not exists public.bot_actions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid references public.whatsapp_accounts(id) on delete set null,
  group_id uuid references public.whatsapp_groups(id) on delete set null,
  rule_id uuid references public.group_rules(id) on delete set null,
  trigger_whatsapp_message_id text,
  action_type text not null,
  status text not null,
  detail jsonb,
  created_at timestamptz not null default now()
);

comment on table public.bot_actions is
  'Audit of every action the rule engine''s action engine executed (or skipped), and why (Phase 5).';

create index if not exists bot_actions_group_created_idx on public.bot_actions (group_id, created_at);

alter table public.bot_actions enable row level security;

-- ---------------------------------------------------------------------
-- whatsapp_audit_logs
-- ---------------------------------------------------------------------
-- General-purpose activity feed for the dashboard's Activity page —
-- message received, rule evaluated, threshold progress, config changed,
-- etc. Distinct from bot_actions, which is specifically "what the bot DID."
--
-- Named `whatsapp_audit_logs`, not the more obvious `audit_logs` — this
-- Supabase project already has an unrelated `audit_logs` table (a
-- pre-existing CRM table, not created by or related to this project; see
-- docs/DECISIONS.md ADR-012). Every other table in this migration uses a
-- `whatsapp_`/domain-specific prefix precisely to avoid this kind of
-- collision; `audit_logs` was the one generic name that didn't, and it
-- collided on the very first apply attempt.
create table if not exists public.whatsapp_audit_logs (
  id uuid primary key default gen_random_uuid(),
  account_id uuid references public.whatsapp_accounts(id) on delete set null,
  group_id uuid references public.whatsapp_groups(id) on delete set null,
  actor text not null default 'system',
  event_type text not null,
  detail jsonb,
  created_at timestamptz not null default now()
);

comment on table public.whatsapp_audit_logs is
  'General activity feed for the dashboard Activity page (Phase 4+5). Never contains credentials, keys, or raw Baileys payloads. Named with the whatsapp_ prefix to avoid colliding with this project''s pre-existing, unrelated audit_logs (CRM) table.';

create index if not exists whatsapp_audit_logs_created_idx on public.whatsapp_audit_logs (created_at);
create index if not exists whatsapp_audit_logs_group_created_idx on public.whatsapp_audit_logs (group_id, created_at);

alter table public.whatsapp_audit_logs enable row level security;
