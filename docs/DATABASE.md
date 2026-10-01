# Database Design (Supabase / Postgres)

**Status:** the three "Implemented" sections below are real and live —
Phase 3 (WhatsApp account + auth-state persistence,
`supabase/migrations/20261001120000_whatsapp_core.sql`), Phase 4+5
(event pipeline, group config, rule engine,
`supabase/migrations/20261001140000_whatsapp_groups_rules.sql`), and
Phase 6+ (AI, auto-reply, commands, deleted-message/view-once archive,
calls, moderation, `supabase/migrations/20261001160000_whatsapp_ai_commands_moderation.sql`).
"Minimum viable schema (historical sketch)" further down is **fully
superseded** now — owner/admin identity still uses the
`OWNER_WHATSAPP_NUMBERS`/`ADMIN_WHATSAPP_NUMBERS` env vars (no `admins`
table was built), and private-contact settings remain genuinely unbuilt,
but every other sketch there (`groups`, `group_settings`, `group_rules`,
`messages`, `call_events`, `bot_actions`, `ai_usage`, `audit_logs`) has a
real, differently-shaped implementation documented above it in this file.
This document exists so later phases build toward a consistent schema
instead of improvising table-by-table.

## Implemented (Phase 3): WhatsApp account + auth-state persistence

Three tables, applied via
`supabase/migrations/20261001120000_whatsapp_core.sql`. Full rationale in
`docs/DECISIONS.md` ADR-011; encryption details in `docs/SECURITY.md`.

**Design choices that apply to all three tables:**

- Every sensitive column (`ciphertext`, `iv`, `auth_tag`) is base64-encoded
  `text`, not `bytea` — this avoids depending on exactly how PostgREST
  represents binary columns over JSON. The database only ever stores
  ciphertext; plaintext credentials/keys never reach Postgres.
- Row Level Security is enabled on all three tables with **no** policies for
  `anon` or `authenticated` — default-deny. Only the `service_role` key
  (server-side only, bypasses RLS by design) can read or write them.
- `updated_at` is set explicitly by application code on every write, not by
  a database trigger (one less moving part).

### `whatsapp_accounts`

Durable account registry — replaces the Phase 2B JSON manifest in
production. Deliberately holds only durable config, never transient
connection state (connecting/reconnecting/QR), which stays in
`WhatsAppConnectionManager`'s memory and is reported live via SSE.

| column            | type                 | notes               |
| ----------------- | -------------------- | ------------------- |
| id                | uuid pk              | `gen_random_uuid()` |
| label             | text                 | 1–60 chars          |
| enabled           | boolean default true |                     |
| created_at        | timestamptz          |                     |
| updated_at        | timestamptz          |                     |
| last_connected_at | timestamptz nullable |                     |

### `whatsapp_auth_credentials`

One row per account: the encrypted Baileys `AuthenticationCreds` object
(identity keys, registration id, `advSecretKey`, etc.).

| column      | type                                                  | notes                            |
| ----------- | ----------------------------------------------------- | -------------------------------- |
| account_id  | uuid pk, fk → whatsapp_accounts.id, on delete cascade |                                  |
| ciphertext  | text                                                  | base64 AES-256-GCM ciphertext    |
| iv          | text                                                  | base64, 12 bytes                 |
| auth_tag    | text                                                  | base64, 16 bytes                 |
| key_version | smallint default 1                                    | reserved for future key rotation |
| updated_at  | timestamptz                                           |                                  |

### `whatsapp_auth_keys`

The Baileys signal key store — pre-keys, sessions, sender keys,
app-state-sync keys/versions. One row per `(account_id, category, key_id)`,
relationally mirroring Baileys' own `useMultiFileAuthState` file-naming
scheme (`${category}-${id}.json`).

| column      | type                                               | notes                                                                                                                                             |
| ----------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| account_id  | uuid, fk → whatsapp_accounts.id, on delete cascade | part of composite pk                                                                                                                              |
| category    | text                                               | one of Baileys' `SignalDataTypeMap` keys: `pre-key`, `session`, `sender-key`, `sender-key-memory`, `app-state-sync-key`, `app-state-sync-version` |
| key_id      | text                                               | part of composite pk                                                                                                                              |
| ciphertext  | text                                               | base64 AES-256-GCM ciphertext                                                                                                                     |
| iv          | text                                               | base64, 12 bytes                                                                                                                                  |
| auth_tag    | text                                               | base64, 16 bytes                                                                                                                                  |
| key_version | smallint default 1                                 |                                                                                                                                                   |
| updated_at  | timestamptz                                        |                                                                                                                                                   |
| **pk**      |                                                    | `(account_id, category, key_id)` — enforces per-account isolation at the schema level                                                             |

Index: `(account_id, category)`, supporting bulk category reads (Baileys
requests keys as `get(category, ids[])`) and account-removal cleanup.

## Implemented (Phase 4+5): event pipeline, group config, rule engine

Ten tables, applied via
`supabase/migrations/20261001140000_whatsapp_groups_rules.sql`. Full
rationale in `docs/DECISIONS.md` ADR-012. Same conventions as Phase 3: RLS
enabled with no anon/authenticated policies, `updated_at` set by
application code, `gen_random_uuid()` generated client-side (not a DB
default — see `src/db/groupsRepository.ts` etc.) so every repository can
immediately use the id it just inserted without a round-trip.

This section **supersedes** the speculative `groups` / `group_settings` /
`group_rules` / `messages` / `bot_actions` / `audit_logs` designs further
down this document — the real schema differs from what was originally
sketched (different column names, and three tables — `rule_matches`,
`rule_match_responders`, `rule_cooldowns` — that weren't anticipated at
all, needed for durable rule state). `admins`, `contacts`, `call_events`,
and `ai_usage` remain genuinely unbuilt and are still accurately described
by the speculative section.

### `whatsapp_groups`

Durable group registry. Identity is the WhatsApp group JID, never the
display name (a rename updates `subject` in place — see
`src/whatsapp/groups/groupDiscovery.ts`).

| column             | type                                               | notes                              |
| ------------------ | -------------------------------------------------- | ---------------------------------- |
| id                 | uuid pk                                            |                                    |
| account_id         | uuid, fk → whatsapp_accounts.id, on delete cascade |                                    |
| whatsapp_group_jid | text                                               | identity, with account_id          |
| subject            | text                                               | current display name               |
| discovered_at      | timestamptz                                        |                                    |
| updated_at         | timestamptz                                        |                                    |
| **unique**         |                                                    | `(account_id, whatsapp_group_jid)` |

### `group_settings`

1:1 with `whatsapp_groups`. Every toggle defaults to `false` — see
docs/DECISIONS.md ADR-012 on safe defaults. Columns beyond
`bot_enabled`/`monitoring_enabled` are configuration architecture for
features not yet implemented (Phase 6+) — accepted and persisted by the
dashboard, but not read by any behavior yet.

| column                                 | type                             | notes                                                                                                                   |
| -------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| group_id                               | uuid pk, fk → whatsapp_groups.id |                                                                                                                         |
| bot_enabled                            | boolean default false            | master switch — gates rule evaluation                                                                                   |
| monitoring_enabled                     | boolean default false            | gates whatsapp_messages storage                                                                                         |
| ai_enabled                             | boolean default false            | Phase 6+: one of three gates for AI-powered auto-reply/classify                                                         |
| auto_reply_enabled                     | boolean default false            | Phase 6+: gates auto_reply rule evaluation                                                                              |
| deleted_message_archive_enabled        | boolean default false            | Phase 6+: gates deleted-message (REVOKE) archiving                                                                      |
| view_once_handling_enabled             | boolean default false            | Phase 6+: gates view-once media archiving                                                                               |
| call_handling_enabled                  | boolean default false            | accepted for backward compatibility, not read — calls are configured per-ACCOUNT, see `whatsapp_account_settings` below |
| moderation_enabled                     | boolean default false            | Phase 6+: gates moderation rule evaluation                                                                              |
| custom_group_instructions              | text nullable                    | Phase 6+: fed into AI-generated-reply prompts as owner config                                                           |
| custom_ai_instructions                 | text nullable                    | Phase 6+: fed into AI-generated-reply prompts as owner config                                                           |
| default_cooldown_seconds               | integer default 0                | reserved; per-rule cooldownSeconds is what's actually used today                                                        |
| ai_auto_reply_enabled                  | boolean default false            | Phase 6+: 2nd of three AI-auto-reply gates                                                                              |
| ai_semantic_classification_enabled     | boolean default false            | Phase 6+: 3rd of three AI-auto-reply gates — also gates AI classification in general                                    |
| ai_cooldown_seconds                    | integer default 0                | Phase 6+: min seconds between successful AI calls for this group                                                        |
| ai_max_responses_per_hour              | integer nullable                 | Phase 6+: null = unlimited                                                                                              |
| deleted_message_retention_days         | integer nullable                 | Phase 6+: null = keep forever; else 7/30/90-style purge window                                                          |
| media_max_file_size_bytes              | bigint default 16777216          | Phase 6+: view-once/media size limit, checked before download                                                           |
| moderation_destructive_actions_enabled | boolean default false            | Phase 6+: separate explicit gate — DELETE_MESSAGE/REMOVE_USER are skipped unless this is true                           |
| updated_at                             | timestamptz                      |                                                                                                                         |

### `whatsapp_processed_events`

Always-on idempotency gate for every inbound message, independent of
monitoring/bot settings.

| column              | type                                               | notes                                         |
| ------------------- | -------------------------------------------------- | --------------------------------------------- |
| account_id          | uuid, fk → whatsapp_accounts.id, on delete cascade | part of pk                                    |
| chat_jid            | text                                               | part of pk                                    |
| whatsapp_message_id | text                                               | part of pk                                    |
| processed_at        | timestamptz                                        |                                               |
| **pk**              |                                                    | `(account_id, chat_jid, whatsapp_message_id)` |

### `whatsapp_messages`

Optional normalized archive, written only when a group's
`monitoring_enabled` is true. Deliberately not a raw Baileys payload dump.

| column                     | type                                                      | notes                                         |
| -------------------------- | --------------------------------------------------------- | --------------------------------------------- |
| id                         | uuid pk                                                   |                                               |
| account_id                 | uuid, fk → whatsapp_accounts.id, on delete cascade        |                                               |
| group_id                   | uuid nullable, fk → whatsapp_groups.id, on delete cascade |                                               |
| chat_jid                   | text                                                      |                                               |
| whatsapp_message_id        | text                                                      |                                               |
| sender_jid                 | text                                                      | participant for group messages                |
| from_me                    | boolean default false                                     |                                               |
| message_type               | text                                                      | Baileys' `getContentType()` result            |
| text_content               | text nullable                                             |                                               |
| quoted_whatsapp_message_id | text nullable                                             | drives rule target-message matching           |
| deleted / deleted_at       | boolean / timestamptz nullable                            | reserved for Phase 7                          |
| created_at                 | timestamptz                                               |                                               |
| **unique**                 |                                                           | `(account_id, chat_jid, whatsapp_message_id)` |

Indexes: `(group_id, created_at)`, `(account_id, chat_jid, quoted_whatsapp_message_id)`.

### `group_rules`

| column                  | type                                             | notes                                                  |
| ----------------------- | ------------------------------------------------ | ------------------------------------------------------ |
| id                      | uuid pk                                          |                                                        |
| group_id                | uuid, fk → whatsapp_groups.id, on delete cascade |                                                        |
| name                    | text                                             | 1-80 chars                                             |
| enabled                 | boolean default true                             |                                                        |
| trigger_type            | text                                             | `response_threshold` is the only value implemented     |
| config                  | jsonb                                            | strictly zod-validated — see `src/rules/ruleConfig.ts` |
| created_at / updated_at | timestamptz                                      |                                                        |

### `rule_matches`

One row per `(rule, target WhatsApp message)` — the durable
threshold-progress and fired-state record.

| column                     | type                                         | notes                                   |
| -------------------------- | -------------------------------------------- | --------------------------------------- |
| id                         | uuid pk                                      |                                         |
| rule_id                    | uuid, fk → group_rules.id, on delete cascade |                                         |
| target_whatsapp_message_id | text                                         |                                         |
| fired                      | boolean default false                        | flipped via atomic compare-and-set      |
| fired_at                   | timestamptz nullable                         |                                         |
| created_at / updated_at    | timestamptz                                  |                                         |
| **unique**                 |                                              | `(rule_id, target_whatsapp_message_id)` |

### `rule_match_responders`

| column              | type                                          | notes                                                                   |
| ------------------- | --------------------------------------------- | ----------------------------------------------------------------------- |
| rule_match_id       | uuid, fk → rule_matches.id, on delete cascade | part of pk                                                              |
| sender_jid          | text                                          | part of pk — **this composite PK is what enforces "N distinct people"** |
| whatsapp_message_id | text                                          |                                                                         |
| responded_at        | timestamptz                                   |                                                                         |

### `rule_cooldowns`

| column        | type                                            | notes |
| ------------- | ----------------------------------------------- | ----- |
| rule_id       | uuid pk, fk → group_rules.id, on delete cascade |       |
| last_fired_at | timestamptz                                     |       |

### `bot_actions`

What the action engine actually did (or skipped) and why.

| column                          | type                                  | notes                                          |
| ------------------------------- | ------------------------------------- | ---------------------------------------------- |
| id                              | uuid pk                               |                                                |
| account_id / group_id / rule_id | uuid nullable, fk, on delete set null |                                                |
| trigger_whatsapp_message_id     | text nullable                         |                                                |
| action_type                     | text                                  | `SEND_MESSAGE` \| `LOG_ONLY` \| `NOTIFY_OWNER` |
| status                          | text                                  | `success` \| `failed` \| `skipped`             |
| detail                          | jsonb nullable                        | e.g. cooldown remaining seconds, send error    |
| created_at                      | timestamptz                           | indexed with group_id                          |

### `whatsapp_audit_logs`

General activity feed for the dashboard's Activity page — distinct from
`bot_actions` (specifically "what the bot did"). Named with a `whatsapp_`
prefix rather than the more obvious `audit_logs` because this Supabase
project already has an unrelated, pre-existing `audit_logs` table (not
part of this project — discovered when the first migration attempt
collided with it) — see docs/DECISIONS.md ADR-012.

| column                | type                                  | notes                                                          |
| --------------------- | ------------------------------------- | -------------------------------------------------------------- |
| id                    | uuid pk                               |                                                                |
| account_id / group_id | uuid nullable, fk, on delete set null |                                                                |
| actor                 | text default 'system'                 | `'system'` or `'owner'` (dashboard config changes)             |
| event_type            | text                                  | e.g. `rule.threshold_progress`, `rule.fired`, `config.changed` |
| detail                | jsonb nullable                        | never credentials/keys/raw payloads — see docs/SECURITY.md     |
| created_at            | timestamptz                           | indexed, and indexed with group_id                             |

## Implemented (Phase 6+): AI, auto-reply, commands, archive, calls, moderation

Six new tables plus the `group_settings` extensions documented above,
applied via `supabase/migrations/20261001160000_whatsapp_ai_commands_moderation.sql`.
Same conventions as every prior migration: RLS enabled with no
anon/authenticated policies, `created_at`/`updated_at` set by application
code, ids generated client-side. Checked against `information_schema` for
collisions with this Supabase project's pre-existing tables before being
applied (the `audit_logs` collision from Phase 4+5 — see ADR-012 — made
this a standing practice, not a one-off).

### `whatsapp_ai_usage`

Every AI service call, successful or not — the source of truth for the
per-group AI cooldown/rate-limit policy (`src/ai/aiUsagePolicy.ts`) and for
auditing "why did the bot call OpenAI." Never stores prompt/response text.

| column                            | type                                  | notes                                           |
| --------------------------------- | ------------------------------------- | ----------------------------------------------- |
| id                                | uuid pk                               |                                                 |
| account_id                        | uuid, fk → whatsapp_accounts, cascade |                                                 |
| group_id / rule_id                | uuid nullable, fk, on delete set null |                                                 |
| reason                            | text                                  | e.g. `auto_reply_classify`, `command_ai_ask`    |
| model                             | text                                  |                                                 |
| prompt_tokens / completion_tokens | integer nullable                      |                                                 |
| latency_ms                        | integer nullable                      |                                                 |
| success                           | boolean                               |                                                 |
| error                             | text nullable                         | short message only, never a full stack/response |
| created_at                        | timestamptz                           | indexed with group_id and with account_id       |

### `whatsapp_media_archive`

Metadata for archived media (view-once today; general archiving is
reserved). The bytes live in the private `whatsapp-media` Supabase Storage
bucket (`public: false`, no anonymous policies), never in a Postgres
column — see `src/whatsapp/archive/viewOnceHandler.ts`.

| column                  | type                                  | notes                                                                          |
| ----------------------- | ------------------------------------- | ------------------------------------------------------------------------------ |
| id                      | uuid pk                               |                                                                                |
| account_id              | uuid, fk → whatsapp_accounts, cascade |                                                                                |
| group_id                | uuid nullable, fk, on delete set null |                                                                                |
| whatsapp_message_id     | text                                  |                                                                                |
| sender_jid              | text                                  |                                                                                |
| is_view_once            | boolean default false                 |                                                                                |
| storage_path            | text                                  | path within `whatsapp-media`                                                   |
| mime_type               | text                                  |                                                                                |
| file_size_bytes         | bigint                                |                                                                                |
| sha256                  | text nullable                         |                                                                                |
| created_at / expires_at | timestamptz / timestamptz nullable    | `expires_at` reserved — no retention sweep for media yet, see docs/SECURITY.md |

### `whatsapp_call_events`

Signaling metadata only — never call audio/video (Baileys doesn't
implement WebRTC media handling; see ADR-001).

| column                | type                                  | notes                                                                                            |
| --------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------ |
| id                    | uuid pk                               |                                                                                                  |
| account_id            | uuid, fk → whatsapp_accounts, cascade |                                                                                                  |
| caller_jid / chat_jid | text                                  |                                                                                                  |
| group_id              | uuid nullable, fk, on delete set null | best-effort; most calls have no group context                                                    |
| is_group / is_video   | boolean default false                 |                                                                                                  |
| status                | text                                  | Baileys' `WACallUpdateType`                                                                      |
| action_taken          | text nullable                         | `logged` \| `notified_owner` \| `rejected` \| `sent_message` \| `reject_failed` \| `send_failed` |
| created_at            | timestamptz                           | indexed with account_id                                                                          |

### `whatsapp_moderation_state`

Durable per-(rule, sender) sliding window for the deterministic
"repeated messages" spam heuristic — survives a restart like
`rule_matches`/`rule_cooldowns` do.

| column            | type                            | notes      |
| ----------------- | ------------------------------- | ---------- |
| rule_id           | uuid, fk → group_rules, cascade | part of pk |
| sender_jid        | text                            | part of pk |
| window_started_at | timestamptz                     |            |
| message_count     | integer default 0               |            |

### `whatsapp_notification_cooldowns`

Dedup/cooldown for owner notifications triggered outside the rule engine's
own per-rule cooldown (a deleted message detected, a call attempted).

| column           | type                                  | notes                                                            |
| ---------------- | ------------------------------------- | ---------------------------------------------------------------- |
| account_id       | uuid, fk → whatsapp_accounts, cascade | part of pk                                                       |
| notification_key | text                                  | part of pk, e.g. `deleted_message:<groupId>`, `call:<callerJid>` |
| last_sent_at     | timestamptz                           |                                                                  |

### `whatsapp_account_settings`

Call handling, configured per **WhatsApp account**, not per group — an
incoming call isn't reliably scoped to a specific monitored group the way
messages are. Also carries Emergency Pause (`automation_paused`, added in
Phase 7 below) for the same reason: pausing autonomous behavior is an
account-wide decision, not a per-group one. See docs/DECISIONS.md.

| column                | type                                     | notes                                                                 |
| --------------------- | ---------------------------------------- | --------------------------------------------------------------------- |
| account_id            | uuid pk, fk → whatsapp_accounts, cascade |                                                                       |
| call_handling_enabled | boolean default false                    |                                                                       |
| call_response_action  | text default 'LOG_ONLY'                  | `LOG_ONLY` \| `NOTIFY_OWNER` \| `AUTO_REJECT` \| `SEND_MESSAGE_AFTER` |
| call_response_message | text nullable                            |                                                                       |
| automation_paused     | boolean default false                    | Emergency Pause — see Phase 7 below                                   |
| updated_at            | timestamptz                              |                                                                       |

### Supabase Storage: `whatsapp-media` bucket

Private (`public: false`), created by the same migration
(`insert into storage.buckets ...`). No anonymous/public policies on
`storage.objects` for this bucket — same default-deny, service-role-only
access model as every table in this project. The dashboard never links to
it directly; `GET /api/groups/:id/media-archive/:mediaId/url` mints a
60-second signed URL per authenticated request.

## Implemented (Phase 7): private contacts, admin management, pause/dry-run/inbox

Two migrations: `supabase/migrations/20261001200000_whatsapp_private_contacts.sql`
(private contacts + DB-managed admins + nullable `contact_id` added to
`group_rules`/`bot_actions`/`whatsapp_audit_logs`/`whatsapp_ai_usage`/
`whatsapp_messages`, each with a `..._scope_check` CHECK constraint enforcing
exactly one of `group_id`/`contact_id` set) and
`supabase/migrations/20261001210000_whatsapp_pause_dryrun_inbox.sql`
(`automation_paused` on `whatsapp_account_settings`, `dry_run_enabled` on
`group_settings`/`contact_settings`, and the new `owner_inbox_items` table).
Same RLS/id/timestamp conventions as every prior migration.

### `whatsapp_contacts` / `contact_settings`

Private-chat (DM) equivalent of `whatsapp_groups`/`group_settings` — a
contact is discovered lazily on its first DM, same pattern as group
discovery, and always starts with safe-defaults (all-off) settings. `blocked`
is a real, hard, unconditional gate (checked before monitoring, commands, or
rule evaluation); `allowlisted` is deliberately informational-only — a
second behavioral gate alongside per-contact toggles would itself be a dead
control.

| column (contact_settings)                  | notes                                                               |
| ------------------------------------------- | -------------------------------------------------------------------- |
| private_monitoring_enabled                  | required to store messages / archive deletions for this contact      |
| private_ai_enabled / private_auto_reply_enabled / private_ai_auto_reply_enabled / private_ai_semantic_classification_enabled | mirrors the group four-gate AI permission pattern (src/rules/ruleEngine.ts) |
| private_deleted_message_archive_enabled      |                                                                        |
| dry_run_enabled                             | see Phase 7's Dry Run entry below                                     |
| custom_instructions / custom_ai_instructions | per-contact prompt context                                           |
| ai_cooldown_seconds / ai_max_responses_per_hour / deleted_message_retention_days | same semantics as the group equivalents |

### `whatsapp_admins`

Dashboard-managed admin numbers, additive to (never a replacement for) the
env-only `ADMIN_WHATSAPP_NUMBERS` — merged at authorization-check time via
`resolveAdminNumbers()` in both command handlers. `OWNER_WHATSAPP_NUMBERS`
has no DB-backed equivalent and never can: the owner identity is
structurally prevented from being written by any code path, so there is no
privilege-escalation path through the dashboard. See docs/SECURITY.md.

| column     | type                                  | notes                  |
| ---------- | ------------------------------------- | ----------------------- |
| id         | uuid pk                               |                         |
| account_id | uuid, fk → whatsapp_accounts, cascade |                         |
| phone_jid  | text                                  | normalized WhatsApp JID |
| label      | text nullable                         |                         |
| created_at | timestamptz                           |                         |

### Emergency Pause (`whatsapp_account_settings.automation_paused`)

Account-level, not a cross-account singleton — the dashboard can still
present a "pause everything" action by looping the PATCH across every
account. Stops autonomous outbound automation: rule actions, auto-reply,
moderation actions, and the `AUTO_REJECT`/`SEND_MESSAGE_AFTER` call
responses. Deliberately does **not** block: monitoring/storage, owner/admin
in-chat commands, or owner notifications (deleted-message pings,
`NOTIFY_OWNER` call responses) — pausing stops the bot's own autonomous
decisions, never the owner's own visibility or explicit requests. Checked in
`src/whatsapp/events/eventPipeline.ts` (both the group and private message
paths) and `src/whatsapp/calls/callHandler.ts`.

### Dry Run (`group_settings.dry_run_enabled` / `contact_settings.dry_run_enabled`)

Per-group/per-contact. The rule engine evaluates a rule exactly as it
normally would — qualification, threshold/distinct-responder tracking,
cooldown — but skips the real `executeAction`/`executeModerationAction`
call. Instead it records a `bot_actions` row with `status: 'skipped'` and
`detail.reason: 'dry_run'` plus a human-readable `detail.wouldHaveActed`
string (e.g. `send message: "Thanks!"`), and a `rule.dry_run` /
`moderation.dry_run` audit event instead of `rule.fired`/`moderation.fired`.
Cooldown state (`rule_cooldowns`/`recordFired`) still advances as if the
rule had fired, so a dry run accurately simulates what would happen on
every subsequent evaluation too. See `src/rules/ruleEngine.ts`.

### `owner_inbox_items`

A human-readable "look at this" feed for the dashboard's `/inbox` page —
distinct from the full raw `whatsapp_audit_logs`/`bot_actions` trail the
Activity page reads (every rule evaluation, every message received). Only
ever populated from structured data already known at the call site, never
AI-generated guessing about what happened. See `src/db/ownerInboxRepository.ts`.

| column     | type                                   | notes                                                                                                 |
| ---------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| id         | uuid pk                                |                                                                                                        |
| account_id | uuid, fk → whatsapp_accounts, cascade  |                                                                                                        |
| group_id   | uuid nullable, fk, on delete cascade   |                                                                                                        |
| contact_id | uuid nullable, fk, on delete cascade   |                                                                                                        |
| category   | text                                   | `deleted_message` \| `missed_call` \| `moderation` \| `ai_failure` \| `disconnected` \| `automation_failure` \| `rule_fired` |
| title      | text                                   | the human-readable headline shown on the card                                                          |
| detail     | jsonb nullable                         |                                                                                                        |
| read       | boolean default false                  |                                                                                                        |
| dismissed  | boolean default false                  |                                                                                                        |
| created_at | timestamptz                            | indexed, newest first                                                                                   |

Wired at five sites: deleted messages (group + private), incoming call
offers, a moderation action firing, and AI reply generation failures (group
+ private). Deliberately **not** wired for new-group-discovery or a generic
automation-failure catch-all in this pass.

## Design principles

- **UUID primary keys** (`gen_random_uuid()`) everywhere except natural
  external keys (e.g. WhatsApp JIDs), which are stored as `text`.
- **Idempotency keys** on anything derived from a WhatsApp event: unique
  constraints on the WhatsApp message key / event id so re-processing the
  same webhook/event is a safe upsert.
- **Every table that scopes behavior to a chat carries `group_id` (or
  `contact_id` for DMs) as a foreign key**, enforcing the per-group isolation
  the product spec requires.
- **Indexes** on every high-volume lookup path: message id lookup (for
  deletion matching), group id, sender id, `created_at` for time-window
  queries (e.g. the 5-person-threshold rule's response window).
- **Row Level Security** will be enabled on all tables once the dashboard
  (Phase 12) introduces authenticated, non-service-role access. Until then,
  the bot process talks to Postgres with the Supabase service role key
  server-side only — RLS doesn't gate that key, so policies are not a
  substitute for keeping the service key off any client surface.

## Minimum viable schema (target for Phase 6+)

This is the planned schema for moderation, AI usage accounting, and
owner/admin identity beyond the `OWNER_WHATSAPP_NUMBERS` env var —
documented here for continuity. **Not created yet.** The `groups`,
`group_settings`, `group_rules`, `messages`, `bot_actions`, and
`audit_logs` sketches immediately below are **superseded** by the real
Phase 4+5 schema documented above (`whatsapp_groups`, `group_settings`,
`group_rules`, `whatsapp_messages`, `bot_actions`, `whatsapp_audit_logs`)
— left here only as a historical record of the original design sketch,
not as a build target.

### `admins`

Owner/admin WhatsApp identities allowed to issue privileged commands.

| column          | type        | notes                      |
| --------------- | ----------- | -------------------------- |
| id              | uuid pk     |                            |
| whatsapp_number | text unique | E.164-style digits, no `+` |
| role            | text        | `owner` \| `admin`         |
| created_at      | timestamptz |                            |

### `groups`

One row per WhatsApp group the bot has seen.

| column            | type        | notes                      |
| ----------------- | ----------- | -------------------------- |
| id                | uuid pk     |                            |
| whatsapp_group_id | text unique | the group JID              |
| name              | text        | last-known subject, cached |
| created_at        | timestamptz |                            |
| updated_at        | timestamptz |                            |

### `group_settings`

1:1 with `groups`. Off-by-default toggles.

| column                          | type                    | notes |
| ------------------------------- | ----------------------- | ----- |
| group_id                        | uuid pk, fk → groups.id |       |
| bot_enabled                     | boolean default false   |       |
| ai_enabled                      | boolean default false   |       |
| monitoring_enabled              | boolean default false   |       |
| auto_reply_enabled              | boolean default false   |       |
| deleted_message_archive_enabled | boolean default false   |       |
| view_once_handling_enabled      | boolean default false   |       |
| call_handling_enabled           | boolean default false   |       |
| moderation_enabled              | boolean default false   |       |
| custom_ai_instructions          | text nullable           |       |
| custom_group_instructions       | text nullable           |       |
| updated_at                      | timestamptz             |       |

### `group_rules`

Owner-defined rules scoped to one group (the "5-person congratulations rule"
lives here).

| column                  | type                 | notes                                                              |
| ----------------------- | -------------------- | ------------------------------------------------------------------ |
| id                      | uuid pk              |                                                                    |
| group_id                | uuid fk → groups.id  | indexed                                                            |
| name                    | text                 | human label                                                        |
| trigger_type            | text                 | e.g. `response_threshold`, `keyword`, `command`                    |
| config                  | jsonb                | threshold, qualifying phrases, time window, action, cooldown, etc. |
| requires_ai             | boolean              | whether trigger/condition evaluation needs an AI classification    |
| enabled                 | boolean default true |                                                                    |
| created_at / updated_at | timestamptz          |                                                                    |

### `contacts`

DM-side equivalent of `groups` plus allow/block state.

| column                     | type                  | notes |
| -------------------------- | --------------------- | ----- |
| id                         | uuid pk               |       |
| whatsapp_number            | text unique           |       |
| display_name               | text nullable         |       |
| private_ai_enabled         | boolean default false |       |
| private_auto_reply_enabled | boolean default false |       |
| private_monitoring_enabled | boolean default false |       |
| allowlisted                | boolean default false |       |
| blocked                    | boolean default false |       |
| created_at / updated_at    | timestamptz           |       |

### `messages`

Stored messages, the basis for the deleted-message archive. Only ever
contains messages the bot actually received while connected — see the
limitation noted in `docs/DECISIONS.md` (ADR-001).

| column                     | type                            | notes                                                                   |
| -------------------------- | ------------------------------- | ----------------------------------------------------------------------- |
| id                         | uuid pk                         |                                                                         |
| whatsapp_message_id        | text                            | the library's message id                                                |
| whatsapp_remote_jid        | text                            | chat the message belongs to                                             |
| from_me                    | boolean                         |                                                                         |
| **unique**                 |                                 | `(whatsapp_remote_jid, whatsapp_message_id, from_me)` — idempotency key |
| group_id                   | uuid fk → groups.id, nullable   | null for DMs                                                            |
| contact_id                 | uuid fk → contacts.id, nullable | null for groups                                                         |
| sender_whatsapp_number     | text                            | indexed                                                                 |
| message_type               | text                            | text, image, video, audio, document, sticker, ...                       |
| text_content               | text nullable                   |                                                                         |
| quoted_whatsapp_message_id | text nullable                   |                                                                         |
| media_metadata             | jsonb nullable                  | mime type, size, sha256 — not the media itself                          |
| deleted                    | boolean default false           |                                                                         |
| deleted_at                 | timestamptz nullable            |                                                                         |
| created_at                 | timestamptz                     | indexed, used for time-window rule evaluation                           |

Indexes: `(whatsapp_remote_jid, whatsapp_message_id)`, `group_id`,
`sender_whatsapp_number`, `created_at`.

### `call_events`

| column                 | type                  | notes                                   |
| ---------------------- | --------------------- | --------------------------------------- |
| id                     | uuid pk               |                                         |
| whatsapp_call_id       | text                  |                                         |
| caller_whatsapp_number | text                  | indexed                                 |
| status                 | text                  | offer, ringing, reject, accept, timeout |
| responded              | boolean default false | whether the configured auto-reply fired |
| created_at             | timestamptz           |                                         |

### `bot_actions`

Audit log of every action the bot executed, and the dedup key that makes
rule firing idempotent.

| column             | type                               | notes                                                                          |
| ------------------ | ---------------------------------- | ------------------------------------------------------------------------------ |
| id                 | uuid pk                            |                                                                                |
| source             | text                               | `rule` \| `command` \| `moderation`                                            |
| rule_id            | uuid fk → group_rules.id, nullable |                                                                                |
| group_id           | uuid fk → groups.id, nullable      |                                                                                |
| contact_id         | uuid fk → contacts.id, nullable    |                                                                                |
| trigger_message_id | text nullable                      | the message/event that caused this                                             |
| action_type        | text                               | `reply`, `react`, `kick`, `warn`, ...                                          |
| **unique**         |                                    | `(rule_id, trigger_message_id)` where both are non-null — prevents double-fire |
| status             | text                               | `success` \| `failed`                                                          |
| detail             | jsonb nullable                     |                                                                                |
| created_at         | timestamptz                        | indexed                                                                        |

### `ai_usage`

| column                            | type                               | notes                                                                   |
| --------------------------------- | ---------------------------------- | ----------------------------------------------------------------------- |
| id                                | uuid pk                            |                                                                         |
| purpose                           | text                               | `classify_response`, `generate_reply`, `moderation_classification`, ... |
| rule_id                           | uuid fk → group_rules.id, nullable |                                                                         |
| group_id                          | uuid fk → groups.id, nullable      |                                                                         |
| model                             | text                               |                                                                         |
| prompt_tokens / completion_tokens | integer                            |                                                                         |
| success                           | boolean                            |                                                                         |
| created_at                        | timestamptz                        |                                                                         |

Deliberately does **not** store full prompt/response text by default —
see `docs/SECURITY.md` on minimizing retained sensitive content.

### `audit_logs`

General-purpose audit trail for configuration changes and command execution
(distinct from `bot_actions`, which is specifically automated WhatsApp
actions).

| column     | type           | notes                                             |
| ---------- | -------------- | ------------------------------------------------- |
| id         | uuid pk        |                                                   |
| actor      | text           | admin/owner identity, or `system`                 |
| action     | text           | e.g. `group_settings.updated`, `command.executed` |
| target     | text nullable  | e.g. group id                                     |
| detail     | jsonb nullable |                                                   |
| created_at | timestamptz    | indexed                                           |

## Deferred tables (not in Phase 3's minimum schema)

Documented so they aren't forgotten, not because they're needed yet:

- `media_archive` — metadata + storage-location pointers for retained media
  (view-once captures, archived deleted-message attachments), with explicit
  retention/expiry columns. Needs the retention policy from
  `docs/SECURITY.md` nailed down before the schema is finalized.
- ~~`sessions`~~ — **implemented in Phase 3** as `whatsapp_auth_credentials` +
  `whatsapp_auth_keys` (see "Implemented (Phase 3)" above), not as a single
  table — Baileys' auth state splits naturally into "one row of creds" and
  "many rows of signal keys", so the schema follows that shape directly.
- `ai_conversations` — only needed once a feature requires multi-turn AI
  context rather than single-shot classification/generation calls.

## Open questions for Phase 6+

- ~~Exact `jsonb` shape for `group_rules.config` per trigger type~~ —
  **resolved in Phase 5**: `response_threshold`'s shape is
  `{targetMessageMatch, qualify: {mode, phrases}, threshold, action,
cooldownSeconds}`, strictly validated by `src/rules/ruleConfig.ts`
  (zod). Future trigger types add their own schema to the same file's
  discriminated union.
