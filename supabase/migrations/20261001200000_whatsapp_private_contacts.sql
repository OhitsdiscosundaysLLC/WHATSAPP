-- Private-contact (DM) automation — the "optionally per DM contact" half of
-- the original product spec (docs/PROJECT_SPEC.md goal 1, docs/SECURITY.md
-- "Private-chat automation is opt-in"). Purely additive: no existing table
-- is dropped, renamed, or has a column removed. Mirrors the group/
-- group_settings/group_rules shape as closely as possible so the existing,
-- already-tested rule engine, audit trail, and AI-usage policy can be
-- reused for contact scope with minimal new surface area.

-- ---------------------------------------------------------------------
-- whatsapp_contacts: DM-side equivalent of whatsapp_groups.
-- ---------------------------------------------------------------------
create table if not exists whatsapp_contacts (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references whatsapp_accounts(id) on delete cascade,
  whatsapp_jid text not null,
  display_name text,
  -- Hard safety gate: a blocked contact is never automated for, full stop,
  -- regardless of any other setting below. Checked first, everywhere.
  blocked boolean not null default false,
  -- Informational only (dashboard bookkeeping) — deliberately does not gate
  -- any runtime behavior itself; the explicit private_* toggles below are
  -- the only real "allow" mechanism, so a second redundant gate here would
  -- be a dead control. See docs/DECISIONS.md.
  allowlisted boolean not null default false,
  discovered_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, whatsapp_jid)
);
alter table whatsapp_contacts enable row level security;

create index if not exists whatsapp_contacts_account_id_idx on whatsapp_contacts(account_id);

-- ---------------------------------------------------------------------
-- contact_settings: DM-side equivalent of group_settings. Every automation
-- toggle defaults to false/off — a newly-discovered contact (the bot's
-- owner just received a first DM from someone) must never start
-- automatically responding (product spec goal 6).
-- ---------------------------------------------------------------------
create table if not exists contact_settings (
  contact_id uuid primary key references whatsapp_contacts(id) on delete cascade,
  private_monitoring_enabled boolean not null default false,
  private_ai_enabled boolean not null default false,
  private_auto_reply_enabled boolean not null default false,
  private_ai_auto_reply_enabled boolean not null default false,
  private_ai_semantic_classification_enabled boolean not null default false,
  private_deleted_message_archive_enabled boolean not null default false,
  custom_instructions text,
  custom_ai_instructions text,
  default_cooldown_seconds integer not null default 0,
  ai_cooldown_seconds integer not null default 0,
  ai_max_responses_per_hour integer,
  deleted_message_retention_days integer,
  updated_at timestamptz not null default now()
);
alter table contact_settings enable row level security;

-- ---------------------------------------------------------------------
-- group_rules: generalize to allow a rule to be scoped to a contact
-- instead of a group. Exactly one of (group_id, contact_id) must be set —
-- a rule is never ambiguous about what it applies to.
-- ---------------------------------------------------------------------
alter table group_rules alter column group_id drop not null;
alter table group_rules add column if not exists contact_id uuid references whatsapp_contacts(id) on delete cascade;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'group_rules_scope_check'
  ) then
    alter table group_rules add constraint group_rules_scope_check check (
      (group_id is not null and contact_id is null) or
      (group_id is null and contact_id is not null)
    );
  end if;
end $$;

create index if not exists group_rules_contact_id_idx on group_rules(contact_id);

-- ---------------------------------------------------------------------
-- Audit/action/usage/message tables: add nullable contact_id alongside the
-- existing nullable group_id, same additive pattern used throughout this
-- project (see docs/DATABASE.md's original contact_id-on-bot_actions design).
-- ---------------------------------------------------------------------
alter table bot_actions add column if not exists contact_id uuid references whatsapp_contacts(id) on delete cascade;
create index if not exists bot_actions_contact_id_idx on bot_actions(contact_id);

alter table whatsapp_audit_logs add column if not exists contact_id uuid references whatsapp_contacts(id) on delete cascade;
create index if not exists whatsapp_audit_logs_contact_id_idx on whatsapp_audit_logs(contact_id);

alter table whatsapp_ai_usage add column if not exists contact_id uuid references whatsapp_contacts(id) on delete cascade;
create index if not exists whatsapp_ai_usage_contact_id_idx on whatsapp_ai_usage(contact_id);

alter table whatsapp_messages add column if not exists contact_id uuid references whatsapp_contacts(id) on delete cascade;
create index if not exists whatsapp_messages_contact_id_idx on whatsapp_messages(contact_id);

-- ---------------------------------------------------------------------
-- whatsapp_admins: dashboard-managed admins, augmenting (never replacing)
-- the env-configured ADMIN_WHATSAPP_NUMBERS. The owner stays exclusively
-- env-configured (OWNER_WHATSAPP_NUMBERS) — the one number that can never
-- be set from inside the product itself, which is what prevents an admin
-- from ever promoting themselves (or anyone) to owner. See docs/SECURITY.md.
-- ---------------------------------------------------------------------
create table if not exists whatsapp_admins (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references whatsapp_accounts(id) on delete cascade,
  -- Digits-only phone number, same format as ADMIN_WHATSAPP_NUMBERS entries.
  phone_number text not null,
  label text,
  added_by text not null default 'owner',
  created_at timestamptz not null default now(),
  unique (account_id, phone_number)
);
alter table whatsapp_admins enable row level security;
create index if not exists whatsapp_admins_account_id_idx on whatsapp_admins(account_id);
