# Architecture

## Layering

```
┌─────────────────────────────────────────────────────────────┐
│ WhatsApp (via Baileys socket)                                │
└───────────────┬────────────────────────────────────────────┘
                 │ raw library events
┌───────────────▼────────────────────────────────────────────┐
│ whatsapp/  — connection lifecycle, auth, event subscription  │
│   client.ts   connect/reconnect, socket lifecycle            │
│   auth.ts     credential/session persistence                 │
│   events.ts   subscribes to socket events, normalizes shape  │
│   messages.ts outgoing-message helpers                       │
│   calls.ts    call event normalization                       │
│   media.ts    media download/decrypt helpers                 │
└───────────────┬────────────────────────────────────────────┘
                 │ normalized internal events
┌───────────────▼────────────────────────────────────────────┐
│ handlers/  — one handler per event category, each responsible│
│              for loading context (group config, etc.) and    │
│              delegating to services/rules                    │
│   messageHandler.ts    groupHandler.ts   privateHandler.ts   │
│   commandHandler.ts    deletionHandler.ts                     │
│   callHandler.ts       mediaHandler.ts                        │
└───────────────┬────────────────────────────────────────────┘
                 │
┌───────────────▼────────────────────────────────────────────┐
│ rules/  — decides IF and HOW to act; AI is a dependency it   │
│           calls only when a matched rule needs it            │
│   ruleEngine.ts   groupRules.ts   triggerDetector.ts          │
│   conditionEvaluator.ts   actionExecutor.ts                   │
└───────────────┬────────────────────────────────────────────┘
                 │
┌───────────────▼────────────────────────────────────────────┐
│ services/  — stateless-ish integrations used by the layers   │
│              above: persistence, AI, logging                 │
│   database.ts  messageStore.ts  mediaStore.ts  groupService.ts│
│   ruleService.ts  callService.ts  ai.ts  logger.ts  ...       │
└────────────────────────────────────────────────────────────┘
```

`commands/` (WhatsApp-native `.bot on` style commands) and `moderation/`
(kick/ban/warn) sit alongside `rules/` as other producers of actions that go
through the same `actionExecutor`, so every action — whether triggered by a
rule or an explicit owner command — is logged and permission-checked the same
way.

## Why AI is not in the hot path

Every inbound event hits the rule engine first. The rule engine's job is to
answer, as cheaply as possible:

1. Is automation even on for this chat? (group disabled → stop immediately)
2. Does any configured rule's _trigger_ match this event at all (keyword,
   message type, participant-count threshold, command prefix, etc.)?
3. Only if a trigger matches and the rule is marked as needing semantic
   judgement (e.g. "is this response _positive_?") does the rule engine call
   `services/ai.ts`.
4. The AI call returns a narrow, structured answer (e.g. a classification),
   not a freeform reply. The rule engine — not the AI — remains responsible
   for counting qualifying users, checking cooldowns, and deciding whether to
   fire the configured action.

This keeps per-message OpenAI usage close to zero in the common case (no
rules matched) and makes AI usage auditable and bounded (Phase 6 logs every
AI call with its purpose, rule, and group).

## Idempotency

WhatsApp can redeliver events (reconnects, retries). Two places need
idempotency:

- **Storage**: messages/events are upserted keyed by WhatsApp's own stable
  identifier (message key: `remoteJid` + `id` + `fromMe`), so storing the
  same event twice is a no-op, not a duplicate row.
- **Actions**: before executing an action, the action executor checks
  `bot_actions` for an existing record keyed by `(rule_id, trigger_message_id)`
  (or the equivalent natural key for non-rule actions). If one exists, the
  action is skipped. This is what prevents the "5-person congratulations
  rule" from firing twice if the 5th qualifying message is processed twice.

## Per-group isolation

Every piece of config, every rule, and every cooldown/dedup record is scoped
by `group_id` (or contact id, for DMs). The rule engine only ever loads and
evaluates rules for the specific chat an event belongs to — there is no
global rule list applied everywhere. See `docs/DATABASE.md`.

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

## Phase scope so far

**Phase 1** — generic application shell: `src/config/config.ts` (typed,
validated environment configuration), `src/services/logger.ts` (structured
logging), `src/services/healthService.ts` (composes a `HealthReport` from
injected component status — see `src/server.ts`), minimal Express app.

**Phase 2** (this phase) — `src/whatsapp/` as described above, wired into
startup/shutdown and `/health`/`/ready`. No message content is read, stored,
or acted upon — `handlers/`, `rules/`, `commands/`, and `moderation/` still
don't exist, per `docs/DEVELOPMENT_PLAN.md`.
