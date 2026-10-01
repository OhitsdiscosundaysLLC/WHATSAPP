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

## Phase 1 scope

This phase implements only the generic application shell that every later
phase builds on:

- `src/config/config.ts` — typed, validated environment configuration.
- `src/services/logger.ts` — structured logging.
- `src/services/healthService.ts` — in-process status reporting (app,
  database, WhatsApp), honestly reporting `not_implemented` for components
  later phases will build.
- `src/server.ts` / `src/index.ts` — minimal Express app exposing
  `GET /health`, and the process entry point.

No `whatsapp/`, `handlers/`, `rules/`, `commands/`, or `moderation/` code
exists yet — those are introduced in the phases that need them, per
`docs/DEVELOPMENT_PLAN.md`.
