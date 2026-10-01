# WhatsApp Automation Bot

A configurable WhatsApp automation bot: per-group rules, selective AI
assistance, deleted-message archiving (within WhatsApp's protocol limits),
configurable media/view-once and call handling, moderation, and (eventually)
a web dashboard.

This is an original, from-scratch project. It is not a fork, clone, or
derivative of any other WhatsApp bot — see `docs/DECISIONS.md` for the
technical decisions behind it, made independently for this codebase.

**Status: Phase 1 — project foundation only.** There is no WhatsApp
connection, no database connection, and no AI integration yet. See
`docs/DEVELOPMENT_PLAN.md` for the full phase roadmap.

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

- `GET /health` — application/component status (JSON)
- `GET /` — basic info

Phase 1 doesn't require any of the `.env` values to be filled in to run —
`npm run dev` starts cleanly with everything unconfigured, and `/health`
reports `not_implemented` for the database and WhatsApp components until
Phases 2 and 3 land.

### Scripts

| Command                                   | Purpose                                     |
| ----------------------------------------- | ------------------------------------------- |
| `npm run dev`                             | Start the app in watch mode (`tsx watch`)   |
| `npm run build`                           | Compile TypeScript to `dist/`               |
| `npm start`                               | Run the compiled app (`node dist/index.js`) |
| `npm run lint` / `npm run lint:fix`       | ESLint                                      |
| `npm run format` / `npm run format:check` | Prettier                                    |
| `npm run typecheck`                       | `tsc --noEmit`                              |

## Project structure

```
src/
  index.ts            entry point: logging, server start, graceful shutdown
  server.ts           Express app (health endpoint, future dashboard API)
  config/
    config.ts         typed, validated environment configuration
  services/
    logger.ts          structured (pino) logging
    healthService.ts    app/component status reporting
docs/                  architecture, database, security, and planning docs
```

Later phases add `whatsapp/`, `handlers/`, `rules/`, `commands/`,
`moderation/`, and more `services/` — see `docs/ARCHITECTURE.md` for the
full target layout and `docs/DEVELOPMENT_PLAN.md` for when each lands.

## Environment variables

See [`.env.example`](.env.example) for the full list with comments. Secrets
are never hardcoded and never committed — all configuration is read from
environment variables via `src/config/config.ts`.
