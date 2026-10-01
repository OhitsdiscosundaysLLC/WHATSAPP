# Development Plan

Work proceeds in phases. Each phase should land as its own reviewable change
before the next begins — this file is updated as phases complete.

- [x] **Phase 1 — Project foundation & architecture** (this phase)
      Tooling (TypeScript, ESLint, Prettier), `docs/`, environment
      configuration loading, structured logging, minimal Express app with a
      health/status endpoint. No WhatsApp, database, or AI integration yet.
- [x] **Phase 2 — WhatsApp connection/session**
      Added `@whiskeysockets/baileys@^6.7.24`, full connection lifecycle
      (`src/whatsapp/`): `AuthStateProvider` abstraction + local-file
      implementation, QR auth (terminal rendering, deduped), capped
      exponential backoff reconnect with an inactivity watchdog, explicit
      logout vs. transient-disconnect handling, `/health` + `/ready`
      reflecting real connection state, graceful shutdown that preserves
      the session. Production-durable auth storage deferred to Phase 3 (see
      docs/DECISIONS.md ADR-006) — still no message/event processing, no
      database, no AI.
- [x] **Phase 2B — Web pairing dashboard & Render deployment**
      Multi-account registry (`src/whatsapp/accountManager.ts`, replacing
      Phase 2's single-account singleton — see ADR-010), an authenticated
      browser dashboard (`src/web/`: owner login, server-side sessions,
      CSRF, rate-limited login, SSE-based live QR/status), pairing-code
      support (verified against Baileys 6.7.24 — see ADR-001's update) as
      an alternative to scanning a QR, and Render deployment configuration
      (`render.yaml`, `docs/DEPLOYMENT.md`). The owner can now connect
      WhatsApp entirely from a browser — no terminal/VS Code required.
      Session durability across redeploys is still the unsolved Phase 3
      problem (ADR-006) — the dashboard doesn't change that, it just makes
      the existing (re-)pairing flow usable without a terminal.
- [x] **Phase 3 — Supabase database (durable session persistence)**
      Wired up `@supabase/supabase-js` server-side only. AES-256-GCM
      application-level encryption (`src/db/encryption.ts`), a
      `SupabaseAuthStateProvider` storing the full Baileys signal key store
      (not just creds.json), and `SupabaseAccountStore` replacing the JSON
      manifest in production — both selected automatically alongside
      `FileAuthStateProvider`/`JsonManifestAccountStore` for local dev (see
      ADR-011). `/health` reports real database status and which auth
      storage mode is active. WhatsApp sessions now survive a Render
      restart/redeploy without a new QR scan.
- [x] **Phase 4 — Event pipeline & group configuration**
      The production message/event pipeline (`src/whatsapp/events/`):
      normalization, idempotency gate, group/private context
      identification, group discovery (`src/whatsapp/groups/`,
      `groupFetchAllParticipating()` + live `groups.upsert`/`.update`),
      per-group settings (`src/db/groupsRepository.ts`) with every toggle
      safe-default OFF, optional message storage gated on
      `monitoring_enabled`. Dashboard Groups list + group detail pages
      (`src/web/groupRoutes.ts`, `src/web/views/groups.html`,
      `group.html`).
- [x] **Phase 5 — Rule engine**
      `src/rules/ruleEngine.ts`, `src/rules/classifiers/` (deterministic
      exact/contains/keyword matching via a `ResponseClassifier` interface
      AI can later plug into — ADR-012), `src/rules/actionEngine.ts`
      (`SEND_MESSAGE`/`LOG_ONLY`/`NOTIFY_OWNER`). Implemented the
      response-threshold rule type (the "5-person congratulations"
      example) end-to-end without AI: durable threshold progress and
      distinct-sender counting (`src/db/ruleStateRepository.ts`, schema-
      enforced via `rule_match_responders`' composite primary key), atomic
      fires-exactly-once guarantee, cooldowns, and full audit logging
      (`src/db/auditRepository.ts`) — all proven to survive a process
      restart by dedicated tests before any AI classification gets layered
      in (Phase 6).
- [ ] **Phase 6 — AI service**
      `services/ai.ts`, OpenAI integration, structured-output classification
      calls, `ai_usage` logging, wiring AI into the rule engine as an
      on-demand dependency (per `docs/ARCHITECTURE.md`).
- [ ] **Phase 7 — Deleted-message archive**
      `deletionHandler.ts`, revocation-event matching against stored
      messages, with the "delete for me" limitation (ADR-001) enforced in
      behavior, not just documented.
- [ ] **Phase 8 — Media / view-once handling**
      `mediaHandler.ts`, `whatsapp/media.ts`, retention policy enforcement,
      opt-in per group/contact.
- [ ] **Phase 9 — Call handling**
      `callHandler.ts`, `whatsapp/calls.ts`, configurable delayed auto-reply
      to unanswered calls, respecting the "metadata only, no media" limit
      from ADR-001.
- [ ] **Phase 10 — Moderation**
      `moderation/` (warn/kick/ban), permission checks, moderation logging.
- [ ] **Phase 11 — WhatsApp command system**
      `commandHandler.ts`, `commands/`, parser, permission integration,
      audit logging of command execution.
- [ ] **Phase 12 — Web dashboard**
      REST API over the Express app from Phase 1, authentication, RLS,
      eventually a frontend.
- [ ] **Phase 13 — Testing / security hardening**
      Test coverage for rule engine idempotency/dedup logic especially,
      review against `docs/SECURITY.md`.
- [ ] **Phase 14 — Render deployment**
      Production auth-state persistence resolved, environment configured in
      Render, health check wired to Render's monitoring.

## Working agreement

- Each phase's PR/commit should be reviewable on its own — avoid bundling
  unrelated phases together.
- Don't add a dependency before the phase that uses it needs it (see
  ADR-005: Supabase client isn't installed until Phase 3, even though env
  vars are reserved in Phase 1).
- Update this checklist and `docs/DECISIONS.md` as decisions are made or
  revised — don't let them drift from the code.
