-- Phase 6+: AI service, auto-reply, WhatsApp commands, deleted-message
-- archive, view-once/media archive, call handling, moderation, owner
-- notifications.
--
-- Purely additive: extends `group_settings` with new columns (all default
-- to the same "off" safe-default posture as the existing toggles) and adds
-- six new tables, all prefixed `whatsapp_` per the naming lesson from
-- Phase 4+5 (see docs/DECISIONS.md ADR-012's `audit_logs` collision
-- story). Checked against `information_schema` for name collisions with
-- this Supabase project's pre-existing, unrelated tables before being
-- applied — see docs/DECISIONS.md ADR-013.
--
-- Same conventions as every prior migration in this project: RLS enabled
-- with NO anon/authenticated policies (default-deny, service-role-only
-- access), `updated_at`/`created_at` set by application code (not
-- triggers), ids generated client-side via `randomUUID()`.

-- ---------------------------------------------------------------------
-- group_settings: new columns
-- ---------------------------------------------------------------------
-- All default to the "off"/zero/unset posture — a group that already
-- exists (or is newly discovered) gets none of this functionality turned
-- on by this migration. See docs/DECISIONS.md ADR-012's "safe defaults
-- enforced at the point of row creation" decision, which this extends
-- rather than relaxes.

alter table public.group_settings
  add column if not exists ai_auto_reply_enabled boolean not null default false,
  add column if not exists ai_semantic_classification_enabled boolean not null default false,
  add column if not exists ai_cooldown_seconds integer not null default 0,
  add column if not exists ai_max_responses_per_hour integer,
  add column if not exists deleted_message_retention_days integer,
  add column if not exists media_max_file_size_bytes bigint not null default 16777216, -- 16 MiB
  add column if not exists moderation_destructive_actions_enabled boolean not null default false;

comment on column public.group_settings.ai_auto_reply_enabled is
  'Explicit third gate (alongside ai_enabled and auto_reply_enabled) required before an AI-generated auto-reply can fire. All three, plus the firing rule''s own classifier selection, must agree.';
comment on column public.group_settings.ai_semantic_classification_enabled is
  'Separate permission: whether a rule in this group is even allowed to select the AI classifier for qualification, independent of whether it would also need ai_auto_reply_enabled for the action.';
comment on column public.group_settings.deleted_message_retention_days is
  'NULL = no automatic purge. Archived deleted-message content (whatsapp_messages.text_content for rows with deleted = true) older than this is cleared by a periodic sweep; see src/whatsapp/archive/retentionSweep.ts.';
comment on column public.group_settings.media_max_file_size_bytes is
  'Applies to view-once/media archiving only (Phase 8 foundation) — a file whose declared size exceeds this is skipped before download, never partially fetched.';

-- ---------------------------------------------------------------------
-- whatsapp_ai_usage
-- ---------------------------------------------------------------------
-- Every call to the AI service, successful or not. The source of truth
-- for the per-group AI cooldown and max-responses-per-hour checks
-- (src/ai/aiUsagePolicy.ts queries this directly rather than keeping a
-- separate counter table) and for "why did the bot call OpenAI" auditing.
-- Deliberately does NOT store prompt/response text — see docs/SECURITY.md.

create table if not exists public.whatsapp_ai_usage (
  id uuid primary key,
  account_id uuid not null references public.whatsapp_accounts(id) on delete cascade,
  group_id uuid references public.whatsapp_groups(id) on delete set null,
  rule_id uuid references public.group_rules(id) on delete set null,
  reason text not null, -- e.g. 'auto_reply_classify', 'auto_reply_generate', 'response_threshold_classify', 'command_ai_ask'
  model text not null,
  prompt_tokens integer,
  completion_tokens integer,
  latency_ms integer,
  success boolean not null,
  error text,
  created_at timestamptz not null default now()
);

create index if not exists whatsapp_ai_usage_group_created_idx
  on public.whatsapp_ai_usage (group_id, created_at);
create index if not exists whatsapp_ai_usage_account_created_idx
  on public.whatsapp_ai_usage (account_id, created_at);

alter table public.whatsapp_ai_usage enable row level security;

-- ---------------------------------------------------------------------
-- whatsapp_media_archive
-- ---------------------------------------------------------------------
-- Metadata for archived media (view-once captures today; general media
-- archiving is reserved for later). The actual bytes live in the private
-- `whatsapp-media` Supabase Storage bucket, never in a Postgres column.

create table if not exists public.whatsapp_media_archive (
  id uuid primary key,
  account_id uuid not null references public.whatsapp_accounts(id) on delete cascade,
  group_id uuid references public.whatsapp_groups(id) on delete set null,
  whatsapp_message_id text not null,
  sender_jid text not null,
  is_view_once boolean not null default false,
  storage_path text not null, -- path within the `whatsapp-media` bucket
  mime_type text not null,
  file_size_bytes bigint not null,
  sha256 text,
  created_at timestamptz not null default now(),
  expires_at timestamptz
);

create index if not exists whatsapp_media_archive_group_created_idx
  on public.whatsapp_media_archive (group_id, created_at);

alter table public.whatsapp_media_archive enable row level security;

-- ---------------------------------------------------------------------
-- whatsapp_call_events
-- ---------------------------------------------------------------------
-- Signaling metadata only — never call audio/video (Baileys does not
-- implement WebRTC media handling; see docs/DECISIONS.md ADR-001).

create table if not exists public.whatsapp_call_events (
  id uuid primary key,
  account_id uuid not null references public.whatsapp_accounts(id) on delete cascade,
  caller_jid text not null,
  chat_jid text not null,
  group_id uuid references public.whatsapp_groups(id) on delete set null,
  is_group boolean not null default false,
  is_video boolean not null default false,
  status text not null, -- Baileys' WACallUpdateType: offer | ringing | reject | accept | timeout | terminate
  action_taken text, -- 'logged' | 'notified_owner' | 'rejected' | 'sent_message' | null
  created_at timestamptz not null default now()
);

create index if not exists whatsapp_call_events_account_created_idx
  on public.whatsapp_call_events (account_id, created_at);

alter table public.whatsapp_call_events enable row level security;

-- ---------------------------------------------------------------------
-- whatsapp_moderation_state
-- ---------------------------------------------------------------------
-- Durable per-(rule, sender) sliding window for the deterministic
-- "repeated messages" spam heuristic. Survives a restart the same way
-- rule_matches/rule_cooldowns do — state that matters is never only in
-- process memory.

create table if not exists public.whatsapp_moderation_state (
  rule_id uuid not null references public.group_rules(id) on delete cascade,
  sender_jid text not null,
  window_started_at timestamptz not null,
  message_count integer not null default 0,
  primary key (rule_id, sender_jid)
);

alter table public.whatsapp_moderation_state enable row level security;

-- ---------------------------------------------------------------------
-- whatsapp_notification_cooldowns
-- ---------------------------------------------------------------------
-- Dedup/cooldown for owner notifications triggered outside the rule
-- engine's own per-rule cooldown (deleted-message detected, call
-- attempted, automation failure) — "must have cooldown/dedup protection,
-- do not spam the owner" (product spec Part H).

create table if not exists public.whatsapp_notification_cooldowns (
  account_id uuid not null references public.whatsapp_accounts(id) on delete cascade,
  notification_key text not null, -- e.g. 'deleted_message:<groupId>', 'call:<callerJid>'
  last_sent_at timestamptz not null,
  primary key (account_id, notification_key)
);

alter table public.whatsapp_notification_cooldowns enable row level security;

-- ---------------------------------------------------------------------
-- whatsapp_account_settings
-- ---------------------------------------------------------------------
-- Call handling is configured per WhatsApp ACCOUNT, not per group — unlike
-- messages, an incoming call is not reliably scoped to a specific
-- monitored group (most real calls are 1:1/DM calls to the account's own
-- number, and there is no per-contact/DM settings model yet; see
-- docs/DATABASE.md's deferred `contacts` table). See docs/DECISIONS.md
-- for the full rationale.

create table if not exists public.whatsapp_account_settings (
  account_id uuid primary key references public.whatsapp_accounts(id) on delete cascade,
  call_handling_enabled boolean not null default false,
  call_response_action text not null default 'LOG_ONLY', -- LOG_ONLY | NOTIFY_OWNER | AUTO_REJECT | SEND_MESSAGE_AFTER
  call_response_message text,
  updated_at timestamptz not null default now()
);

alter table public.whatsapp_account_settings enable row level security;

-- ---------------------------------------------------------------------
-- Private Supabase Storage bucket for archived media
-- ---------------------------------------------------------------------
-- No public/anonymous access — same service-role-only access model as
-- every table above. `storage.objects` already has RLS enabled by
-- Supabase by default with no public policies for this bucket, so this
-- alone is sufficient; the service role (server-side only) bypasses RLS.

insert into storage.buckets (id, name, public)
values ('whatsapp-media', 'whatsapp-media', false)
on conflict (id) do nothing;
