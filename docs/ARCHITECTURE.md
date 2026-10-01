# Architecture

## Layering (as implemented — Phase 4+5)

```
┌─────────────────────────────────────────────────────────────┐
│ WhatsApp (via Baileys socket)                                │
└───────────────┬────────────────────────────────────────────┘
                 │ raw library events (messages.upsert, groups.upsert/update)
┌───────────────▼────────────────────────────────────────────┐
│ whatsapp/connectionManager.ts — connection lifecycle owner.   │
│ Fans out raw Baileys events via onMessage/onGroupsDiscovered  │
│ callbacks; exposes sendTextMessage(). Interprets nothing.     │
└───────────────┬────────────────────────────────────────────┘
                 │
     ┌───────────┴────────────┐
     ▼                         ▼
┌─────────────────────┐  ┌──────────────────────────────┐
│ whatsapp/groups/     │  │ whatsapp/events/              │
│   groupDiscovery.ts  │  │   messageNormalizer.ts (pure)  │
│   upserts discovered │  │   eventPipeline.ts: dedup →    │
│   groups, safe-      │  │   group lookup → settings      │
│   default settings   │  │   gate → optional store →      │
│                       │  │   optional rule evaluation     │
└──────────┬───────────┘  └───────────────┬───────────────┘
           │                              │ (only when bot_enabled)
           ▼                              ▼
┌──────────────────────┐      ┌──────────────────────────┐
│ db/groupsRepository   │      │ rules/ruleEngine.ts        │
│ db/messagesRepository │      │   loads enabled rules,     │
│ (Supabase-backed —    │      │   evaluates response_      │
│  see ADR-012)         │      │   threshold, durable state │
└───────────────────────┘      │   via db/ruleStateRepository│
                                 │   classifier: rules/        │
                                 │   classifiers/ (deterministic│
                                 │   today; AI pluggable later) │
                                 └───────────────┬───────────┘
                                                  │ fires
                                                  ▼
                                 ┌──────────────────────────┐
                                 │ rules/actionEngine.ts      │
                                 │   SEND_MESSAGE / LOG_ONLY / │
                                 │   NOTIFY_OWNER, via the     │
                                 │   connectionManager's       │
                                 │   sendTextMessage()          │
                                 └───────────────┬───────────┘
                                                  ▼
                                 ┌──────────────────────────┐
                                 │ db/auditRepository.ts      │
                                 │   bot_actions + whatsapp_audit_logs │
                                 │   — the dashboard Activity │
                                 │   page reads from here     │
                                 └──────────────────────────┘
```

`commands/` (`src/whatsapp/commands/commandHandler.ts`) and `moderation/`
(`src/rules/moderation/`) are implemented as of Phase 6+ — see "WhatsApp
commands" and "Moderation" below. Both are producers of actions that go
through either `actionEngine.ts` or its moderation-specific sibling
`moderationActionEngine.ts`, so every action, however triggered, is logged
and permission-checked the same way.

## Why AI is not in the hot path

`rules/classifiers/responseClassifier.ts` defines a `ResponseClassifier`
interface with exactly one method (`classify(text, config) => Promise<boolean>`),
implemented by `DeterministicResponseClassifier` (exact/contains/keyword
matching, no network call, no cost) for `response_threshold` rules.
`RuleEngine` depends only on this interface for that trigger type, never
on OpenAI directly. For `auto_reply` rules (Phase 6+), the equivalent
decoupling is `src/rules/classifiers/autoReplyClassifier.ts`'s
`classifyAutoReply()`, which only ever reaches `AIService.classify()` when
a rule's own config explicitly selects `classifier: 'ai'` **and** three
independent group-level permission gates are all true
(`ai_enabled`/`ai_auto_reply_enabled`/`ai_semantic_classification_enabled`
— see docs/DECISIONS.md ADR-013) **and** the AI usage/rate-limit policy
(`src/ai/aiUsagePolicy.ts`) allows it. AI usage is bounded to exactly these
explicit paths: a rule's classifier selection, a rule's `AI_REPLY` action,
or the `.ai <question>` command — never the default path for an incoming
message. `src/rules/ruleEngine.test.ts` asserts the AI service is never
called unless every gate is on.

## Idempotency

WhatsApp can redeliver events (reconnects, retries). Two separate
mechanisms, deliberately not conflated:

- **Event dedup**: `whatsapp_processed_events` — a composite-PK table
  `(account_id, chat_jid, whatsapp_message_id)`, written unconditionally for
  every inbound message by `MessagesRepository.markProcessed()`, independent
  of any group's settings. A Postgres unique-constraint violation (code
  `23505`) IS the "already processed" signal — `EventPipeline` reads it as
  `false` and stops immediately, before storage or rule evaluation run
  again. See `src/whatsapp/events/eventPipeline.ts`.
- **Rule firing**: `rule_matches.fired`, flipped exactly once via an atomic
  compare-and-set (`UPDATE ... WHERE fired = false`, via
  `RuleStateRepository.tryMarkFired()`). Distinct qualifying responders are
  tracked in `rule_match_responders`, whose composite primary key
  `(rule_match_id, sender_jid)` makes "N distinct people" a schema-level
  guarantee, not an application-level count that could drift.

Both survive a process restart with zero in-memory state — see
`src/db/ruleStateRepository.test.ts` and `src/rules/ruleEngine.test.ts` for
restart-simulation tests that prove it directly.

## Per-group isolation

Every piece of config (`group_settings`), every rule (`group_rules`), and
every cooldown/dedup record (`rule_matches`, `rule_cooldowns`) is scoped by
`group_id`, which is itself scoped by `account_id` (two accounts can have a
group with the identical WhatsApp JID — e.g. the same group added via two
different connected numbers — and they're still two separate rows, two
separate rule sets, two separate settings). `EventPipeline`/`RuleEngine`
only ever load and evaluate rules for the one group an incoming event
belongs to — there is no global rule list applied everywhere. See
`docs/DATABASE.md` and the isolation tests in `src/db/groupsRepository.test.ts`,
`src/rules/ruleEngine.test.ts`, and `src/web/groupRoutes.test.ts`.

## WhatsApp connection lifecycle (Phase 2)

`src/whatsapp/` owns connecting to WhatsApp and nothing else — it does not
read message content, store anything, or run any automation. Its pieces:

```
whatsapp/
  types.ts                 WhatsAppConnectionState, WhatsAppStatus
  client.ts                createWhatsAppSocket(): thin factory around
                            Baileys' makeWASocket, version fetch (timed out,
                            non-fatal if it fails)
  reconnectPolicy.ts        pure functions: decideOnDisconnect(),
                            computeBackoffDelayMs(), extractStatusCode() —
                            no socket, no I/O, directly unit-tested
  qrDisplay.ts               renders a QR to the terminal, deduped so an
                            identical QR isn't reprinted
  connectionManager.ts       orchestrates the lifecycle: one socket at a
                            time, attaches `connection.update` /
                            `creds.update` listeners, drives state
                            transitions, schedules reconnects, distinguishes
                            logout from transient disconnect, owns shutdown
  auth/
    authStateProvider.ts     storage-agnostic interface: init/load/
                            hasExistingSession/clear
    fileAuthStateProvider.ts local-filesystem implementation (dev only —
                            see docs/DECISIONS.md ADR-006 for production)
  whatsappService.ts         singleton wiring (config → auth provider →
                            connection manager), consumed by src/index.ts
                            and src/server.ts
```

**Connection states** (`WhatsAppConnectionState`), set explicitly by the
connection manager at every transition — never inferred from "does a socket
object exist":

`disabled → initializing → connecting → (awaiting_qr →)* connecting → connected`,
with `connected → reconnecting → connecting → connected` on a transient
drop, and a terminal `logged_out` or `error` state when reconnecting isn't
appropriate (see "Reconnect decision" below).

**Startup sequence** (`src/index.ts`): load config → init logger → bind the
HTTP server (so `/health` is available immediately) → start the WhatsApp
connection in the background, non-blocking. A slow or failed WhatsApp
connection never blocks or crashes the HTTP server — this is why WhatsApp
start is fire-and-forget (`void startWhatsApp()`), not awaited.

**Reconnect decision** (`reconnectPolicy.ts`): Baileys reports a disconnect
reason via a Boom error's `output.statusCode`, mapped to one of:

| Outcome               | Example reasons                                                         | Behavior                                                                     |
| --------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `reconnect`           | connection closed/lost, service unavailable, unknown/missing reason     | retry with capped exponential backoff + jitter                               |
| `reconnect_immediate` | Baileys' own `restartRequired`                                          | retry with no delay                                                          |
| `logout`              | WhatsApp reports the device was unlinked (`loggedOut`)                  | clear local auth state, require a new QR                                     |
| `stop`                | connection replaced elsewhere, bad session, forbidden, version mismatch | stop reconnecting, **keep** credentials for diagnosis, surface `error` state |

Credentials are only ever cleared on `logout` (WhatsApp-reported unlink) or
an explicit, owner-initiated `requestLogout()` call — never on a transient
`stop`/`reconnect` outcome. See docs/DECISIONS.md ADR-006 for the full
rationale and the exact DisconnectReason mapping.

**Duplicate-connection prevention**: `start()`/`connect()` no-op (with a
logged warning) if a socket, a pending reconnect timer, or an in-flight
`start()` call already exists. Each `connect()` attaches a fresh listener
set to a fresh socket; the previous socket (if any) is already `null`ed out
before a reconnect fires.

**Graceful shutdown**: stops any pending reconnect timer and calls the
socket's `end()` (closes the local connection) — deliberately **not**
`logout()`, so a normal process restart (e.g. a Render redeploy) preserves
the linked-device session and never requires a new QR scan.

## Readiness vs liveness (`GET /health` vs `GET /ready`)

- `GET /health` is a **liveness** check: it answers "is the Node process
  itself alive and serving requests?" and returns `200` as long as the HTTP
  server is up — including while WhatsApp is `awaiting_qr`, `reconnecting`,
  or in `error` state. It reports the real state of every component
  (`components.whatsapp.status` is the actual `WhatsAppConnectionState`,
  e.g. `"connected"`, `"awaiting_qr"`), it just doesn't fail the whole
  response because of it. Point Render's health check here.
- `GET /ready` is a **readiness** check: it answers "is WhatsApp actually
  usable right now (or intentionally disabled via `WHATSAPP_ENABLED=false`)?"
  and returns `503` while connecting/reconnecting/awaiting QR/errored. Use
  this only if something needs to gate on an actual WhatsApp connection —
  not recommended as the primary deploy health check, since the bot can
  legitimately spend tens of seconds reconnecting after every restart.

Neither endpoint ever includes QR contents, credentials, keys, or WhatsApp
account metadata — see docs/SECURITY.md.

## Multi-account layer (Phase 2B)

`src/whatsapp/accountManager.ts` sits above `connectionManager.ts`: it owns
a registry of accounts, each with its own `WhatsAppConnectionManager` and
its own `FileAuthStateProvider` rooted at
`${WHATSAPP_AUTH_DIR}/<accountId>/`. See docs/DECISIONS.md ADR-010 for why
this replaced Phase 2's single-account `whatsappService.ts` singleton, and
what "multi-account-ready" does and doesn't cover yet.

```
whatsapp/
  accountManager.ts   registry: Map<accountId, {label, createdAt, manager}>,
                       JSON manifest persistence, create/reconnect/
                       disconnect/remove, getAggregateStatus() for /health
  connectionManager.ts (Phase 2, extended) + onUpdate() subscribers,
                       getPairingSnapshot(), requestPairingCode()
```

## Web dashboard layer (Phase 2B)

`src/web/` is the only part of the app allowed to read a `PairingSnapshot`
(i.e. ever see a QR or pairing code) or mutate account state — see
docs/SECURITY.md for the full authentication/CSRF model.

```
web/
  sessionStore.ts        in-memory owner-session store (id, csrfToken, TTL)
  loginRateLimiter.ts     in-memory login-attempt limiter (pure, unit-tested)
  authMiddleware.ts        attachSession / requireAuth / requireCsrf
  authRoutes.ts             POST /login, POST /logout
  dashboardRoutes.ts        GET /login, GET / (dashboard HTML + CSRF inject),
                            GET /groups, /groups/:id, /activity (Phase 4+5
                            pages, same CSRF-inject pattern), static assets
  accountRoutes.ts          /api/accounts/** — list/create/reconnect/
                            disconnect/remove, pairing-code request, and
                            the per-account SSE status stream
  groupRoutes.ts (Phase 4+5) /api/groups/** — list/detail, settings PATCH,
                            rule CRUD (create/update/enable-disable/delete);
                            503s clearly if Supabase isn't configured rather
                            than silently doing nothing
  activityRoutes.ts (Phase 4+5) /api/activity — recent whatsapp_audit_logs +
                            bot_actions, optionally filtered by groupId
  qrImage.ts                 raw QR string -> PNG data URL, server-side,
                            before anything reaches the browser
  public/                    static HTML/CSS/JS (no secrets — safe to be
                            publicly fetchable; the API behind them still
                            requires auth)
  views/                      dashboard.html, groups.html, group.html,
                            activity.html — each a template with a
                            server-injected CSRF token
```

`src/server.ts` composes all of this: `createAuthRouter()` and
`createDashboardRouter()` mount at the root, `createAccountRouter()` mounts
at `/api/accounts`, `cookie-parser` and `express.json()` are applied
globally, and `trust proxy` is enabled in production (Render terminates TLS
at a reverse proxy — without this, `req.ip`/`req.secure` would be wrong,
breaking rate limiting and the `Secure` cookie flag).

### Real-time updates: SSE, not WebSocket or polling

`GET /api/accounts/:id/events` is a Server-Sent Events stream, chosen over
WebSocket or short polling — see docs/DECISIONS.md ADR-008 for the full
reasoning (short version: the data flow is one-directional server→browser,
SSE reuses the existing cookie session with no separate auth handshake, and
the browser's native `EventSource` already handles reconnection). The
dashboard's pairing modal opens one `EventSource` per visible account and
closes it when the modal closes.

## Phase scope so far

**Phase 1** — generic application shell: `src/config/config.ts` (typed,
validated environment configuration), `src/services/logger.ts` (structured
logging), `src/services/healthService.ts` (composes a `HealthReport` from
injected component status — see `src/server.ts`), minimal Express app.

**Phase 2** — `src/whatsapp/` connection lifecycle (client, connection
manager, reconnect policy, auth-state abstraction, QR terminal display),
wired into startup/shutdown and `/health`/`/ready`.

**Phase 2B** — multi-account registry (`src/whatsapp/accountManager.ts`),
the authenticated web dashboard (`src/web/`), pairing-code support,
SSE-based live status, and Render deployment configuration (`render.yaml`,
`docs/DEPLOYMENT.md`). No message content is read, stored, or acted upon
yet at this point.

**Phase 3** — durable, encrypted, Supabase-backed session persistence
(`src/db/encryption.ts`, `src/whatsapp/auth/supabaseAuthStateProvider.ts`,
`src/whatsapp/accountStore.ts`), replacing local-file storage in production.
See docs/DECISIONS.md ADR-011.

**Phase 4+5** — the actual automation product, built on top of the Phase
1-3 infrastructure without modifying the connection/auth layers: the
message/event pipeline (`src/whatsapp/events/`), WhatsApp group discovery
and per-group configuration (`src/whatsapp/groups/`,
`src/db/groupsRepository.ts`), the deterministic rule engine and action
engine (`src/rules/`), durable rule state (`src/db/ruleStateRepository.ts`),
audit logging (`src/db/auditRepository.ts`), and the dashboard's Groups /
group-detail / Activity pages (`src/web/groupRoutes.ts`,
`src/web/activityRoutes.ts`). The one rule type implemented in this phase
was `response_threshold` (the "N distinct people respond" pattern). See
docs/DECISIONS.md ADR-012 for the full design rationale.

**Phase 6+** (this phase) — AI, auto-reply, commands, deleted-message/
view-once archive, call signaling, and deterministic moderation, again
without reworking anything from Phase 1-5:

- `src/ai/` — `AIProvider`/`OpenAIProvider` (fetch-based, no SDK
  dependency), `AIService` (the one place any AI call is made, with
  strict SYSTEM/OWNER/USER prompt separation), `aiUsagePolicy.ts`
  (cooldown + max-per-hour, shared by every AI call site).
- `src/rules/` gained two new `trigger_type`s — `auto_reply` and
  `moderation` — reusing the existing rule/cooldown/audit infrastructure
  rather than building parallel systems (see ADR-013).
  `src/rules/classifiers/autoReplyClassifier.ts` and
  `src/rules/moderation/` (`moderationQualifier.ts`,
  `moderationActionEngine.ts`) hold the new trigger-type-specific logic.
- `src/whatsapp/commands/commandHandler.ts` — owner/admin in-chat
  commands, short-circuiting `EventPipeline.handleMessage()` before the
  `bot_enabled` gate.
- `src/whatsapp/archive/` — `deletedMessageHandler.ts` (WhatsApp
  "delete for everyone" detection), `viewOnceHandler.ts` (opt-in view-once
  media archiving to a private Supabase Storage bucket), `retentionSweep.ts`
  (best-effort periodic purge of expired archived deleted-message text).
- `src/whatsapp/calls/callHandler.ts` — Baileys call-signaling events,
  configured per WhatsApp account (`src/db/accountSettingsRepository.ts`),
  not per group.
- `WhatsAppConnectionManager` gained `deleteMessage()`, `removeParticipant()`,
  `rejectCall()`, and an `onCall` callback — still zero content
  interpretation itself, same pattern as `onMessage`/`onGroupsDiscovered`
  from Phase 4+5.

See docs/DECISIONS.md ADR-013 for the full design rationale, including why
`auto_reply`/`moderation` reuse the rule engine, why AI permission is three
independent gates, and why call handling is account-scoped.

Explicitly **not built** by this phase, per the product spec's own
instruction: AI-powered moderation (moderation stays deterministic-only),
a general (non-view-once) media archive, and a global cross-group AI rate
limit. (Private-DM automation itself was built in Phase 7 below — still
opt-in and off by default, same as group automation.)

**Phase 7** — private (DM) automation parity with groups, dashboard-managed
admin accounts, a System Health page, Emergency Pause, Dry Run mode, and
the Owner Inbox — built on the Phase 4-6+ infrastructure without reworking
it:

- `src/db/contactsRepository.ts` (`WhatsAppContact`/`ContactSettings`,
  mirroring `GroupsRepository`), `src/db/adminsRepository.ts`
  (dashboard-managed admins, additive to `ADMIN_WHATSAPP_NUMBERS`).
- `RuleEngine.evaluatePrivate()`/`evaluateContactAutoReply()` — new,
  parallel methods alongside the untouched group `evaluate()`/
  `evaluateAutoReply()`, reusing the same classifiers/`AIService`/action
  engine/cooldown repository.
- `EventPipeline.handlePrivateMessage()` — the DM-side branch of
  `handleMessage()`: lazy contact discovery, the `blocked` hard gate,
  conditional monitoring/storage, private commands
  (`src/whatsapp/commands/privateCommandHandler.ts`), then
  `evaluatePrivate()`.
- `src/db/ownerInboxRepository.ts` + `owner_inbox_items` — a
  human-readable "look at this" feed, separate from the raw
  `whatsapp_audit_logs`/`bot_actions` Activity trail, wired at five call
  sites (deleted messages group+private, an incoming call offer, a
  moderation action firing, AI reply failures group+private). New
  dashboard page at `/inbox` (`src/web/inboxRoutes.ts`).
- Emergency Pause (`whatsapp_account_settings.automation_paused`) — checked
  in `EventPipeline` (both message paths) and `callHandler.ts`; stops
  autonomous actions, never monitoring/commands/owner-notifications. Toggle
  lives on the `/health` page per account (reusing the existing call-settings
  endpoint).
- Dry Run (`group_settings`/`contact_settings.dry_run_enabled`) — checked
  at all four of `RuleEngine`'s action-dispatch sites; evaluates a rule
  fully (qualify/threshold/cooldown) but logs "would have done X" instead
  of calling `executeAction`/`executeModerationAction`. Toggle lives on
  group/contact detail pages' General tab.
- `src/db/encryption.ts` gained a typed `DecryptionError`, and
  `WhatsAppConnectionManager.start()` reports a specific, actionable status
  for it instead of a generic connection error (see docs/SECURITY.md).

See docs/DECISIONS.md ADR-014 for the full design rationale, including why
private contacts duplicate the group rule-firing path instead of
generalizing it, why `allowlisted` is deliberately not a permission gate,
and what from the broader product spec was explicitly not attempted this
phase (Rule Simulator, Templates, Presets, Schedules, Human Takeover,
Approval-Before-Send, Contact Tags/VIP, Escalation Rules, Risk Labels,
Daily Summary, Analytics, Backup/Export).
