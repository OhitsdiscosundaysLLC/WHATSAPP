# External Integrations

## WhatsApp — Baileys (`@whiskeysockets/baileys`)

See `docs/DECISIONS.md` (ADR-001) for the selection rationale and documented
feature limitations (deletion, view-once, calls, session persistence). Not
installed or connected in Phase 1 — introduced in Phase 2.

Required configuration (reserved in `.env.example`, not yet consumed):

- `WHATSAPP_AUTH_DIR` — local auth-state cache directory for development.
  Production persistence strategy is an open Phase 2 design question (see
  ADR-001 consequences).

## Supabase (Postgres)

Used as the single source of truth for all persisted state: group config,
rules, messages, audit logs (see `docs/DATABASE.md`). Accessed server-side
only, via the service role key — never exposed to any client.

Required configuration (reserved, not yet consumed):

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Not wired up until Phase 3. The Phase 1 health endpoint reports this
component as `not_implemented`.

## OpenAI

Used as a narrow, specific-purpose tool invoked by the rule engine — never as
a default "answer every message" path (see `docs/ARCHITECTURE.md`). Typical
calls: classify whether a message is a semantically positive response,
interpret a group's custom instructions against an event, generate a
configured reply, assist a moderation decision.

Required configuration (reserved, not yet consumed):

- `OPENAI_API_KEY`
- `OPENAI_MODEL` (default suggested: `gpt-4o-mini` — cheap/fast, adequate for
  classification-style calls; revisit per task once Phase 6 defines concrete
  prompts)

Not wired up until Phase 6. Every AI call will be logged to `ai_usage`
(purpose, rule, group, model, token counts, success) per `docs/DATABASE.md`.

## Render (deployment)

Target deployment platform (Phase 14). Implications already reflected in
earlier decisions:

- Filesystem is ephemeral across deploys → WhatsApp auth state and any
  locally cached media cannot rely on local disk in production (ADR-001).
- The app must start and bind to `PORT` quickly and expose a health check
  (`GET /health`, implemented in Phase 1) for Render's health checks.
- Environment variables are configured in Render's dashboard, mirroring
  `.env.example` — never committed.

## GitHub

Source control and CI target for this project's own repository. Not
affiliated with, and does not pull from, the reference project mentioned in
the project brief.
