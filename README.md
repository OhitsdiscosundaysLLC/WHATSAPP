# WhatsApp Automation Bot

A configurable WhatsApp automation bot: per-group rules, selective AI
assistance, deleted-message archiving (within WhatsApp's protocol limits),
configurable media/view-once and call handling, moderation, and (eventually)
a web dashboard.

This is an original, from-scratch project. It is not a fork, clone, or
derivative of any other WhatsApp bot — see `docs/DECISIONS.md` for the
technical decisions behind it, made independently for this codebase.

**Status: Phase 2 — WhatsApp connection/session foundation.** The bot can
connect to WhatsApp (QR auth, persistent local session, reconnect handling),
but still reads no message content and runs no automation. No database
connection, no AI integration yet. See `docs/DEVELOPMENT_PLAN.md` for the
full phase roadmap.

## Documentation

- [`docs/PROJECT_SPEC.md`](docs/PROJECT_SPEC.md) — what this project is and its goals
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — component layering and event flow
- [`docs/DATABASE.md`](docs/DATABASE.md) — Supabase/Postgres schema design
- [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md) — external services and required config
- [`docs/SECURITY.md`](docs/SECURITY.md) — security model and requirements
- [`docs/DEVELOPMENT_PLAN.md`](docs/DEVELOPMENT_PLAN.md) — phase-by-phase roadmap
- [`docs/DECISIONS.md`](docs/DECISIONS.md) — architecture decision records (including the WhatsApp library choice and its documented limitations)

## Getting started

Requires Node.js 20+.

```bash
npm install
cp .env.example .env   # fill in real values as later phases need them
npm run dev
```

The dev server starts an HTTP server (default `http://localhost:3000`) with:

- `GET /health` — liveness + component status (JSON); always `200` while
  the process is up, even mid-reconnect
- `GET /ready` — readiness; `200` once WhatsApp is connected (or
  intentionally disabled), `503` otherwise
- `GET /` — basic info

No `.env` values are required just to run `npm run dev` — Supabase/OpenAI
stay unconfigured and `/health` reports `database` as `not_implemented`
until Phase 3. WhatsApp connects automatically unless
`WHATSAPP_ENABLED=false` is set.

### First-time WhatsApp authentication

1. Run `npm run dev` (or `npm start` against a build).
2. A QR code prints to the terminal — scan it from your phone:
   **WhatsApp → Settings → Linked Devices → Link a Device**.
3. Once scanned, the terminal logs the connection as established and
   `GET /health` reports `components.whatsapp.status: "connected"`.
4. Credentials are cached under `WHATSAPP_AUTH_DIR` (default `./auth`,
   already gitignored). Restarting the process reconnects automatically —
   **no new QR required** — as long as that directory persists.

This local-file auth storage is development-only; see
`docs/DECISIONS.md` (ADR-006) for the production requirement.

### Scripts

| Command                                   | Purpose                                     |
| ----------------------------------------- | ------------------------------------------- |
| `npm run dev`                             | Start the app in watch mode (`tsx watch`)   |
| `npm run build`                           | Compile TypeScript to `dist/`               |
| `npm start`                               | Run the compiled app (`node dist/index.js`) |
| `npm run lint` / `npm run lint:fix`       | ESLint                                      |
| `npm run format` / `npm run format:check` | Prettier                                    |
| `npm run typecheck`                       | `tsc --noEmit`                              |
| `npm test`                                | Run the automated test suite (vitest)       |

## Project structure

```
src/
  index.ts            entry point: logging, server start, graceful shutdown
  server.ts           Express app (health/ready endpoints, future dashboard API)
  config/
    config.ts         typed, validated environment configuration
  services/
    logger.ts          structured (pino) logging, with WhatsApp-auth redaction
    healthService.ts    composes HealthReport/readiness from injected state
  whatsapp/
    types.ts            connection state + status types
    client.ts            thin factory around Baileys' makeWASocket
    connectionManager.ts  lifecycle, reconnect/backoff, logout handling
    reconnectPolicy.ts    pure, unit-tested reconnect-decision logic
    qrDisplay.ts          terminal QR rendering
    whatsappService.ts    singleton wiring, used by index.ts/server.ts
    auth/
      authStateProvider.ts      storage-agnostic interface
      fileAuthStateProvider.ts  local-filesystem implementation (dev only)
docs/                  architecture, database, security, and planning docs
```

Later phases add `handlers/`, `rules/`, `commands/`, `moderation/`, and more
`services/` — see `docs/ARCHITECTURE.md` for the full target layout and
`docs/DEVELOPMENT_PLAN.md` for when each lands.

## Environment variables

See [`.env.example`](.env.example) for the full list with comments. Secrets
are never hardcoded and never committed — all configuration is read from
environment variables via `src/config/config.ts`.
