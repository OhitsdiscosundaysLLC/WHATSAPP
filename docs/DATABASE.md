# Database Design (Supabase / Postgres)

**Status:** design reference for Phase 3+. No migrations exist yet; Phase 1
ships no database connection. This document exists now so later phases build
toward a consistent schema instead of improvising table-by-table.

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

## Minimum viable schema (target for Phase 3)

This is the planned Phase 3 schema, documented here for continuity — **not
created in Phase 1**.

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
- `sessions` — if WhatsApp auth-state persistence moves into Postgres
  (vs. object storage), this holds encrypted credential/key material. Needs
  its encryption-at-rest approach decided first (see ADR-001 consequences).
- `ai_conversations` — only needed once a feature requires multi-turn AI
  context rather than single-shot classification/generation calls.

## Open questions for Phase 3

- Exact `jsonb` shape for `group_rules.config` per trigger type (needs at
  least the `response_threshold` shape worked out for the 5-person rule
  example before Phase 5).
- Whether WhatsApp auth state belongs in Postgres or Supabase Storage.
