-- Phase 3: durable WhatsApp account + auth-state persistence.
--
-- Three tables, deliberately minimal (see docs/DATABASE.md and
-- docs/DECISIONS.md ADR-011 for the full design rationale):
--
--   whatsapp_accounts         durable account registry (replaces the
--                              Phase 2B JSON manifest in production)
--   whatsapp_auth_credentials one row per account: the encrypted Baileys
--                              `creds` blob
--   whatsapp_auth_keys        many rows per account: the encrypted Baileys
--                              signal key store (pre-keys, sessions,
--                              sender keys, app-state-sync keys/versions)
--
-- Every sensitive column is ciphertext only, stored as base64-encoded
-- `text` (not `bytea` — this sidesteps relying on exactly how PostgREST
-- represents binary columns over JSON, which isn't something to guess at;
-- base64 text round-trips through JSON unambiguously). See
-- src/db/encryption.ts (AES-256-GCM, WHATSAPP_AUTH_ENCRYPTION_KEY). The
-- database never sees plaintext credentials or key material.
--
-- RLS is enabled on all three tables with NO policies for `anon` or
-- `authenticated` — default-deny. Only the service_role key (which
-- bypasses RLS by design, and is used server-side only — see
-- docs/SECURITY.md) can read or write these tables. This mirrors the
-- "service role reads/writes, no public policy" pattern already used
-- elsewhere in this Supabase organization for similarly sensitive tables.
--
-- `updated_at` is set explicitly by application code on every write
-- (src/whatsapp/accountStore.ts, src/whatsapp/auth/supabaseAuthStateProvider.ts)
-- rather than via a trigger — one less moving part, and avoids a
-- dependency on a server-side trigger function.
--
-- gen_random_uuid() is built into Postgres core since v13 — no extension
-- needed (this project runs Postgres 17).

-- ---------------------------------------------------------------------
-- whatsapp_accounts
-- ---------------------------------------------------------------------
-- Durable account configuration. Deliberately does NOT store transient
-- connection state (connecting/reconnecting/qr/etc.) — that lives in
-- WhatsAppConnectionManager's memory and is reported live via SSE/
-- /api/accounts, never persisted. This table only answers "which
-- accounts exist and when were they added / last seen connected".
create table if not exists public.whatsapp_accounts (
  id uuid primary key default gen_random_uuid(),
  label text not null check (char_length(label) between 1 and 60),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_connected_at timestamptz
);

comment on table public.whatsapp_accounts is
  'Durable WhatsApp account registry (Phase 3). Transient connection state is never stored here — see src/whatsapp/connectionManager.ts.';

alter table public.whatsapp_accounts enable row level security;
-- No policies: service_role bypasses RLS entirely (server-side only); every
-- other role (anon, authenticated) is denied by default with RLS on and no
-- matching policy. The dashboard never queries this table directly — it
-- only talks to our Express server, which uses the service role key.

-- ---------------------------------------------------------------------
-- whatsapp_auth_credentials
-- ---------------------------------------------------------------------
-- One row per account: the encrypted Baileys `creds` object (identity
-- keys, registration id, advSecretKey, etc. — see Baileys'
-- AuthenticationCreds type, verified against the installed 6.7.24
-- package; docs/DECISIONS.md ADR-011).
create table if not exists public.whatsapp_auth_credentials (
  account_id uuid primary key references public.whatsapp_accounts(id) on delete cascade,
  ciphertext text not null,
  iv text not null,
  auth_tag text not null,
  key_version smallint not null default 1,
  updated_at timestamptz not null default now()
);

comment on table public.whatsapp_auth_credentials is
  'Encrypted Baileys AuthenticationCreds, one row per account. ciphertext/iv/auth_tag are base64-encoded AES-256-GCM output — see src/db/encryption.ts. Plaintext never touches this table.';

alter table public.whatsapp_auth_credentials enable row level security;
-- No anon/authenticated policies — see whatsapp_accounts above.

-- ---------------------------------------------------------------------
-- whatsapp_auth_keys
-- ---------------------------------------------------------------------
-- The Baileys signal key store. One row per (account, category, key id) —
-- directly mirrors Baileys' own `useMultiFileAuthState` file-naming
-- scheme (`${category}-${id}.json`), just relational instead of
-- filesystem-based. `category` is one of Baileys' SignalDataTypeMap keys:
-- 'pre-key', 'session', 'sender-key', 'sender-key-memory',
-- 'app-state-sync-key', 'app-state-sync-version'.
--
-- The composite primary key is what enforces account isolation at the
-- schema level: every row is explicitly scoped to one account_id, and it
-- is structurally impossible for two accounts to share a key row.
create table if not exists public.whatsapp_auth_keys (
  account_id uuid not null references public.whatsapp_accounts(id) on delete cascade,
  category text not null,
  key_id text not null,
  ciphertext text not null,
  iv text not null,
  auth_tag text not null,
  key_version smallint not null default 1,
  updated_at timestamptz not null default now(),
  primary key (account_id, category, key_id)
);

comment on table public.whatsapp_auth_keys is
  'Encrypted Baileys signal key store (pre-keys, sessions, sender keys, app-state-sync keys/versions), one row per (account_id, category, key_id). Mirrors useMultiFileAuthState''s per-key file layout relationally.';

-- Supports WhatsAppConnectionManager.clear() / account removal cleanup,
-- and bulk category reads (Baileys requests keys as `get(category, ids[])`).
create index if not exists whatsapp_auth_keys_account_category_idx
  on public.whatsapp_auth_keys (account_id, category);

alter table public.whatsapp_auth_keys enable row level security;
-- No anon/authenticated policies — see whatsapp_accounts above.
