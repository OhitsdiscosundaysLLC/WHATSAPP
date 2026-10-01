# WhatsApp Automation Bot

A configurable WhatsApp automation bot: per-group rules, selective AI
assistance, deleted-message archiving (within WhatsApp's protocol limits),
configurable media/view-once and call handling, moderation, and a
browser-based dashboard for connecting WhatsApp accounts.

This is an original, from-scratch project. It is not a fork, clone, or
derivative of any other WhatsApp bot — see `docs/DECISIONS.md` for the
technical decisions behind it, made independently for this codebase.

**Status: Phase 2B — web pairing dashboard & deployment.** The owner can
connect one or more WhatsApp accounts entirely from a browser (QR code or a
phone-number pairing code), with no terminal or VS Code required, and
deploy the app to Render with a one-click Blueprint. The bot still reads no
message content and runs no automation — no database, no AI integration
yet. See `docs/DEVELOPMENT_PLAN.md` for the full phase roadmap.

## Documentation

- [`docs/PROJECT_SPEC.md`](docs/PROJECT_SPEC.md) — what this project is and its goals
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — component layering and event flow
- [`docs/DATABASE.md`](docs/DATABASE.md) — Supabase/Postgres schema design
- [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md) — external services and required config
- [`docs/SECURITY.md`](docs/SECURITY.md) — security model and requirements
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — step-by-step Render deployment guide (non-developer friendly)
- [`docs/DEVELOPMENT_PLAN.md`](docs/DEVELOPMENT_PLAN.md) — phase-by-phase roadmap
- [`docs/DECISIONS.md`](docs/DECISIONS.md) — architecture decision records

## Deploying this for real

See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for the full walkthrough —
connect this repository's `main` branch to Render (a `render.yaml`
Blueprint is included), set one password, and open the dashboard at the
public URL Render gives you.

## Getting started (local development)

Requires Node.js 20+.

```bash
npm install
cp .env.example .env
# edit .env: set DASHBOARD_ADMIN_PASSWORD to anything, for local use
npm run dev
```

The dev server starts an HTTP server (default `http://localhost:3000`) with:

- `GET /health` — liveness + component status (JSON, public); always `200`
  while the process is up, even mid-reconnect
- `GET /ready` — readiness (public); `200` once WhatsApp is connected (or
  intentionally disabled), `503` otherwise
- `GET /login` / `GET /` — the dashboard (see below)

No `.env` values besides `DASHBOARD_ADMIN_PASSWORD` are required to run
`npm run dev` — Supabase/OpenAI stay unconfigured and `/health` reports
`database` as `not_implemented` until Phase 3.

### Connecting WhatsApp from the dashboard

1. Open `http://localhost:3000` and log in with `DASHBOARD_ADMIN_PASSWORD`.
2. Click **+ Add WhatsApp Account**, name it, and confirm.
3. Scan the QR code shown (WhatsApp → Settings → Linked Devices → Link a
   Device), or switch to the **Phone number** tab for a pairing code
   instead.
4. The card updates to **Connected** automatically — no page refresh
   needed (the dashboard subscribes to live updates over
   Server-Sent Events; see `docs/DECISIONS.md` ADR-008).
5. Restarting the process reconnects automatically — **no new QR
   required** — as long as the local auth directory persists. This local
   storage is development-only; see `docs/DECISIONS.md` ADR-006 for the
   production requirement, and `docs/DEPLOYMENT.md` for what that means on
   Render today.

### Scripts

| Command                                   | Purpose                                                              |
| ----------------------------------------- | -------------------------------------------------------------------- |
| `npm run dev`                             | Start the app in watch mode (`tsx watch`)                            |
| `npm run build`                           | Compile TypeScript to `dist/` and copy the dashboard's static assets |
| `npm start`                               | Run the compiled app (`node dist/index.js`)                          |
| `npm run lint` / `npm run lint:fix`       | ESLint                                                               |
| `npm run format` / `npm run format:check` | Prettier                                                             |
| `npm run typecheck`                       | `tsc --noEmit`                                                       |
| `npm test`                                | Run the automated test suite (vitest)                                |

## Project structure

```
src/
  index.ts            entry point: logging, server start, graceful shutdown
  server.ts           Express app: health/ready, auth, dashboard, accounts API
  config/
    config.ts         typed, validated environment configuration
  services/
    logger.ts          structured (pino) logging, with auth-material redaction
    healthService.ts    composes HealthReport/readiness from injected state
  whatsapp/
    types.ts             connection state + status/pairing types
    client.ts             thin factory around Baileys' makeWASocket
    connectionManager.ts   lifecycle, reconnect/backoff, pairing, SSE updates
    accountManager.ts       multi-account registry (see docs/DECISIONS.md ADR-010)
    reconnectPolicy.ts      pure, unit-tested reconnect-decision logic
    qrDisplay.ts             terminal QR rendering (dev convenience)
    auth/
      authStateProvider.ts      storage-agnostic interface
      fileAuthStateProvider.ts  local-filesystem implementation (dev only)
  web/
    authMiddleware.ts    session/CSRF middleware
    authRoutes.ts          POST /login, POST /logout
    dashboardRoutes.ts      dashboard HTML + static assets
    accountRoutes.ts        /api/accounts/** incl. the pairing SSE stream
    sessionStore.ts          in-memory owner sessions
    loginRateLimiter.ts      in-memory login-attempt limiter
    qrImage.ts                QR string -> PNG data URL (server-side)
    public/                   static dashboard HTML/CSS/JS
    views/                     server-rendered dashboard template
docs/                  architecture, database, security, deployment, planning docs
render.yaml            Render Blueprint (see docs/DEPLOYMENT.md)
```

Later phases add `handlers/`, `rules/`, `commands/`, `moderation/`, and more
`services/` — see `docs/ARCHITECTURE.md` for the full target layout and
`docs/DEVELOPMENT_PLAN.md` for when each lands.

## Environment variables

See [`.env.example`](.env.example) for the full list with comments. Secrets
are never hardcoded and never committed — all configuration is read from
environment variables via `src/config/config.ts`. The one variable you must
set yourself for the dashboard to work at all is `DASHBOARD_ADMIN_PASSWORD`.
