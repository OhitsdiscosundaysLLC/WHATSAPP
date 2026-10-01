# Security

## Secrets

- All secrets (Supabase service role key, OpenAI API key, any future
  credentials) are read exclusively from environment variables via
  `src/config/config.ts`. None are hardcoded, none are committed.
- `.env` is gitignored. `.env.example` contains only placeholders.
- `src/services/logger.ts` must never be passed raw config/secret objects.
  Config values are logged individually and selectively (e.g. "Supabase
  configured: true/false"), never as a dump of `process.env` or the config
  object.
- The Supabase **service role key** bypasses Row Level Security and must
  only ever be used server-side (bot process, not any future dashboard
  client bundle).

## Permissions model

- **Owner** numbers (`OWNER_WHATSAPP_NUMBERS`) can issue any bot command,
  including moderation and configuration changes, from any chat the bot can
  see them in.
- **Admin** numbers (`ADMIN_WHATSAPP_NUMBERS`) get a subset of commands —
  the exact subset is defined when the command system (Phase 11) is built,
  but moderation/owner-only commands must explicitly check the sender's
  WhatsApp number against this list server-side before executing. The
  message text claiming to be from an admin is never trusted on its own —
  only the WhatsApp-verified sender JID is.
- Every other participant gets no privileged commands. Group membership
  alone never grants bot-configuration access.
- Permission checks happen in the command handler **before** dispatch to any
  action — never inside the action itself, and never skippable by request
  content.

## Private-chat automation is opt-in

DM automation (AI replies, auto-reply, monitoring) is off by default and
requires explicit per-contact configuration (`contacts.private_*_enabled`,
or an `allowlisted` flag). The bot must not start responding to arbitrary
incoming DMs just because it's connected.

## Prompt injection resistance

Group/DM message content is untrusted input, including when it's fed to
OpenAI for classification or reply generation (Phase 6). Mitigations to
apply when that phase is built:

- AI calls for classification tasks must request structured, constrained
  output (e.g. a fixed enum/JSON schema) rather than freeform text the bot
  then executes as instructions.
- Custom group/AI instructions are **owner-authored configuration**, stored
  in `group_settings`, and are the only source of "standing instructions"
  for the AI. Message content from arbitrary group members must never be
  treated as configuration or override owner instructions, even if phrased
  as commands to the AI.
- The AI's output is consumed by the rule engine as data (e.g. "is this
  positive: yes/no"), not as a plan the bot blindly executes.

## Idempotent, validated event processing

- Every WhatsApp event is deduplicated on its stable identifier before
  storage or action (see `docs/ARCHITECTURE.md` and `docs/DATABASE.md`).
  This also protects against a malicious or buggy redelivery being used to
  trigger an action repeatedly (e.g. spamming the 5-person rule's action).
- Any future inbound webhook (e.g. a dashboard API, Phase 12) must validate
  its payload shape and, where applicable, an authentication signature,
  before acting on it.

## Dashboard / API authentication (Phase 12, not yet built)

Reserved requirements for when the dashboard API exists:

- Authenticated access only — no unauthenticated endpoint may read or
  mutate group configuration, rules, or message history.
- Rate limiting on any endpoint that can trigger a WhatsApp send or an AI
  call, to bound cost and abuse.
- Supabase RLS policies enabled once the dashboard introduces non-service
  credentials, scoped so a dashboard user can only see data for groups
  they're authorized for.

## AI usage limits

Once Phase 6 is built: per-group and/or global caps on AI call volume (to
bound OpenAI spend and reduce the blast radius of a misconfigured rule
looping on AI calls), enforced before the call is made, not after.

## Media retention (view-once, Phase 8; deleted-message attachments, Phase 7)

View-once and archived media can contain sensitive personal content.
Requirements for when that phase is built:

- Off by default, per group/contact, same as other automation.
- Explicit retention policy (time-boxed) with automatic deletion of cached
  media after the retention window — not kept indefinitely by default.
- Stored media metadata (`media_archive`, see `docs/DATABASE.md`) is
  separated from the media bytes themselves, with access to the latter
  restricted to the bot process.
- Logging must record _that_ media was captured (for audit) without logging
  the media content itself.

## Audit logging

- `bot_actions` records every automated action (what fired, which rule,
  which message/event caused it, outcome).
- `audit_logs` records configuration changes and command execution (who,
  what, when).
- Neither table is optional scaffolding — they exist from Phase 3 onward so
  the owner can always answer "why did the bot do that?"

## WhatsApp authentication material (Phase 2)

WhatsApp multi-device auth state (`creds.json` + the signal protocol key
store) is equivalent to the keys to the linked WhatsApp account — treated
accordingly:

- **Never logged.** `FileAuthStateProvider` (`src/whatsapp/auth/`) only ever
  logs the auth _directory path_ and booleans (e.g. "has existing session:
  true/false"); it never logs file contents. `src/services/logger.ts`'s
  redact list additionally covers `creds`, `authState`, `keys`, and `qr` (at
  the top level and one level nested) as defense in depth, since the pino
  logger instance passed into Baileys is also used by Baileys' own internal
  logging.
- **QR codes are short-lived and never persisted.** `whatsapp/qrDisplay.ts`
  renders the QR to the terminal via `console.log` (not the structured
  logger) and never writes it to a file, database, or log sink. Identical
  consecutive QR values are not re-rendered, but this is a UX dedupe, not a
  storage mechanism — nothing about a QR is retained after it's superseded.
- **Never exposed via HTTP.** `GET /health` and `GET /ready` report only
  the connection _state_ (e.g. `"awaiting_qr"`, `"connected"`) and
  human-readable `detail` strings — never QR contents, credentials, keys,
  the auth directory path, or WhatsApp account metadata beyond the state
  machine itself.
- **Local file permissions.** `FileAuthStateProvider.init()` creates the
  auth directory with mode `0700` and attempts `chmod 0700` as a
  best-effort follow-up (not all filesystems honor this — failure is
  logged and non-fatal, not silently ignored).
- **`.gitignore` excludes it.** The default `WHATSAPP_AUTH_DIR=./auth`
  matches the pre-existing `auth/` entry in `.gitignore` (added in Phase
  1, before this directory existed — intentional advance coverage).
- **Credentials are cleared only on an explicit, controlled signal**: the
  connection manager distinguishes a WhatsApp-reported unlink
  (`DisconnectReason.loggedOut`) and an owner-initiated `requestLogout()`
  call from every other disconnect reason (transient network issues,
  version mismatches, replaced sessions). See docs/ARCHITECTURE.md's
  reconnect-decision table. `requestLogout()` is reachable only from the
  authenticated dashboard's "Disconnect"/"Remove" actions
  (`src/web/accountRoutes.ts`) — see the dashboard security section below.
- **Production durability and encryption at rest** are explicitly not
  solved by `FileAuthStateProvider` — see docs/DECISIONS.md ADR-006 for
  what the Phase 3 Supabase-backed provider must additionally guarantee.

## Web dashboard authentication (Phase 2B)

See docs/DECISIONS.md ADR-009 for the full rationale. Summary of what's
enforced:

- **Single shared owner password** (`DASHBOARD_ADMIN_PASSWORD`), compared
  with a constant-time, length-normalized check
  (`sha256` + `crypto.timingSafeEqual` — see `src/web/authRoutes.ts`), so
  response timing can't be used to guess the password byte-by-byte. If the
  variable isn't set, the dashboard refuses every login attempt with a
  clear `503 dashboard_not_configured` rather than falling back to "no
  password required."
- **Server-side sessions only.** The cookie (`wa_owner_session`) holds a
  32-byte random token and nothing else — no user data, no claims, nothing
  that would reveal anything if decoded. The real session record lives in
  an in-memory store (`src/web/sessionStore.ts`), so a stolen cookie value
  is only useful until the process restarts or the session's 24h TTL
  elapses, whichever comes first; it can also be invalidated immediately
  by the explicit `/logout` endpoint.
- **Cookie flags**: `HttpOnly` (unreadable to any page JavaScript, so a
  successful XSS still couldn't exfiltrate the session value directly),
  `Secure` in production (`config.isProduction`, never sent over plain
  HTTP once deployed), `SameSite=Lax`, scoped to `path=/`.
- **CSRF**: every mutating request (`POST`/`PUT`/`PATCH`/`DELETE`) under
  `/login` (N/A — no session yet), `/logout`, and `/api/accounts/**` must
  carry an `X-CSRF-Token` header matching the token minted for that
  session and embedded server-side into the dashboard HTML
  (`src/web/authMiddleware.ts`'s `requireCsrf`). `GET`/`HEAD`/`OPTIONS` are
  exempt by design (they must stay read-only, which the API honors — no
  route performs a mutation on a safe method).
- **Login rate limiting**: 5 failed attempts per 15 minutes per client IP
  (`src/web/loginRateLimiter.ts`), independent of the session store, so a
  brute-force attempt against the password gets throttled regardless of
  whether any session exists yet. `app.set('trust proxy', 1)` is enabled in
  production so this keys on the real client IP behind Render's proxy, not
  the proxy's own address.
- **Public vs. private routes**, enforced in `src/server.ts`/`src/web/`:
  `GET /health`, `GET /ready`, `GET /login`, `POST /login`, and the static
  dashboard assets (`styles.css`, `login.js`, `dashboard.js` — no secrets
  in any of them) are reachable without a session. Everything under
  `/api/accounts/**`, `POST /logout`, and `GET /` (the dashboard page
  itself, which embeds the CSRF token) require one — an unauthenticated
  browser request to `GET /` redirects to `/login`; an unauthenticated API
  request gets a `401` JSON body, never a redirect (it's not a browser
  navigation, a redirect would be the wrong contract for a fetch caller).

### QR/pairing-code exposure — explicit boundary

- `WhatsAppStatus` (what `getStatus()` returns, what `/health` and
  `/ready` are built from) **cannot structurally contain** a QR or pairing
  code — the TypeScript type has no such field. `PairingSnapshot` (what
  `getPairingSnapshot()` returns) is a **separate, wider type** that adds
  them; only `src/web/accountRoutes.ts`'s SSE handler ever calls
  `getPairingSnapshot()`, and only after `attachSession` + `requireAuth`
  have already run. `src/whatsapp/connectionManager.test.ts` has a test
  asserting this boundary directly (`getStatus()` has no `qr`/`pairingCode`
  property even while a QR is active).
- The raw QR string is **never sent to the browser**. `src/web/qrImage.ts`
  renders it server-side into a PNG data URL (via the `qrcode` package)
  before it goes out over SSE; the client never receives or handles the
  raw value. It's also never logged (see the Baileys auth-material
  redaction paths above) and never persisted (no table, no file — it only
  ever lives in `WhatsAppConnectionManager`'s in-memory field, cleared on
  connect/replace/close/logout).
- A pairing code is likewise scoped to `PairingSnapshot` only, cleared on
  the same lifecycle events as the QR.

## What's actually enforced in code today (Phases 1-2B)

- Config loading never logs secret values (`src/config/config.ts`,
  `src/services/logger.ts`).
- `.gitignore` excludes `.env` and all local auth/media/session
  directories, including the WhatsApp auth directory in active use since
  Phase 2.
- The health endpoint reports real component status (including the actual
  WhatsApp connection state) rather than claiming integrations work before
  they're implemented, and never leaks WhatsApp authentication material
  (see above) — verified by an automated test (`src/server.test.ts`).
- The dashboard and its account-management API are unreachable without a
  valid owner session; every mutating endpoint additionally requires a
  matching CSRF token — both enforced by middleware, not left to each
  route handler to remember, and both covered by automated tests.
- No message content is read, stored, or acted upon yet — Phase 2B only
  adds connection/account management; `handlers/`, `rules/`, `commands/`,
  and `moderation/` still don't exist.
