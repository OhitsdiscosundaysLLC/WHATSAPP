# Architecture Decisions

This log records the significant technical decisions made for this project and
why. It is specific to this codebase — nothing here is copied from, or
describes, any other project.

---

## ADR-001: WhatsApp connectivity library — Baileys (`@whiskeysockets/baileys`)

**Status:** Accepted (Phase 1)

### Context

The bot needs to connect to a real WhatsApp account and receive/send a broad
set of events: text/media messages in groups and DMs, message revocation
(deletion), group participant changes, group metadata, quoted messages, and
ideally call signaling and view-once media. It needs to run unattended on a
Render web/background service, so resource footprint and operational
stability matter as much as feature coverage.

### Options considered

| Library                                    | Approach                                                                  | Notes                                                                                                                                                                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`@whiskeysockets/baileys`**              | Native WebSocket implementation of the WhatsApp Web multi-device protocol | No browser; actively maintained fork of the original `adiwajshing/baileys`; TypeScript-native                                                                                                                                      |
| `whatsapp-web.js`                          | Puppeteer-driven real Chromium instance automating web.whatsapp.com       | Heavier (ships/launches a full browser), more RAM/CPU, more fragile in constrained containers, but mirrors the actual web client closely                                                                                           |
| Official WhatsApp Cloud API / Business API | Meta-hosted, officially supported                                         | Requires a WhatsApp Business Account, Meta app review, and a verified business; cannot drive a normal personal WhatsApp account the way this project needs; incompatible with the "connect to my own WhatsApp account" requirement |

Both `baileys` and `whatsapp-web.js` are actively maintained as of this
writing (npm registry shows recent publishes for both). The deciding factors
were deployment footprint and architectural fit:

- Baileys speaks the multi-device protocol directly over a WebSocket. It does
  not require Chromium/Puppeteer, which makes it dramatically lighter to run
  on a small Render instance (no headless browser process, no `--no-sandbox`
  flags, no risk of Chromium failing to launch in a constrained container).
- Baileys is TypeScript-first, which fits this project's stack directly.
- Baileys exposes a typed `EventEmitter`-style API (`sock.ev.on(...)`) that
  maps cleanly onto the "WhatsApp Event → Event Normalization → ..." pipeline
  this architecture is built around.

### Decision

Use **`@whiskeysockets/baileys`** as the WhatsApp connectivity layer,
introduced in Phase 2. It is **not** installed as a dependency in Phase 1 —
Phase 1 only documents the decision and reserves configuration (e.g.
`WHATSAPP_AUTH_DIR`) for it.

### Consequences / known limitations

These are documented now so later phases don't silently assume capabilities
the library doesn't actually have. Each of these must be re-verified against
the exact installed version when it is implemented, since WhatsApp's
protocol and Baileys' support for it both change over time.

- **Session persistence.** Multi-device auth state (`creds.json` + signal
  keys) must be persisted somewhere durable. Render's filesystem is
  ephemeral across deploys/restarts on most plans, so the default
  `useMultiFileAuthState` (local folder) is only suitable for local
  development. Production needs a custom auth state store that persists to
  Supabase (or equivalent) — this is a Phase 2 design task, not solved yet.
- **Message deletion/revocation.** Baileys surfaces "delete for everyone" as
  a protocol message (revocation) event. **"Delete for me"** is a
  per-device-local action in WhatsApp and is never transmitted to other
  devices/participants — it is **not observable** by the bot at all. The
  deleted-message archive (Phase 7) can therefore only ever recover messages
  that (a) were sent/received while the bot was online and connected, and
  (b) were revoked via "delete for everyone". This limitation is structural
  to the WhatsApp protocol, not a Baileys gap, and must be stated plainly to
  end users of the bot.
- **View-once media.** Baileys receives the actual encrypted media for
  view-once messages the same way it receives any other media message, so
  downloading it (before the viewing device marks it opened) is technically
  possible. This is a capability with real privacy/consent implications —
  see `docs/SECURITY.md`. It must be opt-in per group/contact, never
  default-on, and exact behavior (timing, whether a "viewed" protocol
  message still gets sent) must be validated empirically in Phase 8 against
  the installed Baileys version, not assumed from documentation.
- **Calls.** Baileys exposes a `call` event with call metadata (offer,
  ringing, reject, accept, timeout) from WhatsApp's signaling layer. It does
  **not** implement WebRTC media handling — the bot can detect that a call
  happened and its outcome, but cannot answer, record, or stream audio/video
  for a call. Phase 9's "auto-reply to a missed call" feature is feasible;
  "the bot answers the call" is not, and must never be advertised as
  supported.
- **Protocol churn.** WhatsApp periodically changes its web protocol, which
  has historically required Baileys releases to catch up, sometimes causing
  temporary breakage. The architecture should treat the WhatsApp connection
  as something that can go down and must reconnect/resync rather than an
  always-available dependency.
- **Terms of Service.** Automating a personal WhatsApp account is against
  WhatsApp's Terms of Service regardless of library choice; this is a
  pre-existing risk of the project's premise, not something introduced by
  Baileys specifically. Documented here for visibility, not re-litigated.

### Alternatives revisited later

If Baileys becomes unmaintained or a specific required event is dropped,
`whatsapp-web.js` is the fallback, accepting the Puppeteer/Chromium
operational cost. The event-normalization layer in this architecture exists
partly so a library swap would only require rewriting the `whatsapp/`
adapter, not the rule engine or anything downstream of it.

### Update (Phase 2): exact version pinned, and a package-naming wrinkle

At Phase 2 implementation time, `npm view @whiskeysockets/baileys` showed:

- `dist-tags`: `latest` → `7.0.0-rc14`, `legacy` → `6.7.24`.
- The package is **also** published, from the same repository and in
  lockstep, as the unscoped `baileys` (same version, same publish
  timestamp). Neither name is deprecated. This project continues to use the
  scoped `@whiskeysockets/baileys` name from ADR-001 for continuity; the
  unscoped name is a valid equivalent if preferred later.
- `latest` resolving to a **release candidate** of an unreleased major
  version (`7.0.0-rc14`, 14 RCs in) is unusual — it means a plain
  `npm install @whiskeysockets/baileys` today installs pre-release
  software. `7.x` also adds a new `whatsapp-rust-bridge` native dependency,
  indicating a substantial internal rewrite versus the `6.x` line.

**Decision:** pin to `^6.7.24` (the `legacy` dist-tag's version — the last
published stable `6.x` release), not `latest`. The caret range stays within
`6.x` (never auto-upgrades into the `7.0.0` prerelease line). Rationale: a
Phase 2 goal is a _reliable_ connection foundation; shipping a release
candidate of a major rewrite — with a new native dependency whose build/
runtime behavior on Render hasn't been evaluated — to production is the
wrong trade for that goal. All APIs this project uses
(`makeWASocket`, `useMultiFileAuthState`, `DisconnectReason`,
`fetchLatestBaileysVersion`, `makeCacheableSignalKeyStore`, the
`connection.update`/`creds.update` event shapes) were verified directly
against `6.7.24`'s installed type declarations, not assumed from memory or
older tutorials. **Revisit this pin once WhiskeySockets ships a stable
`7.0.0` final release** — re-verify the same API surface before upgrading,
since a major version bump is exactly when breaking changes are allowed.

Also confirmed from `6.7.24`'s types: `printQRInTerminal` (a `SocketConfig`
option some older tutorials rely on) is marked
`@deprecated This feature has been removed` even in this "stable" line —
the QR must be read from the `connection.update` event's `qr` field and
rendered by the application itself, which is what `whatsapp/qrDisplay.ts`
does (via `qrcode-terminal`).

---

## ADR-002: Runtime & module system — Node.js 20+, TypeScript, CommonJS

**Status:** Accepted (Phase 1)

CommonJS (not ESM) was chosen for the compiled output to maximize
compatibility with the WhatsApp/Node ecosystem (several libraries in this
space still assume CJS interop) and to keep the build simple (`tsc`, no
bundler needed). `tsx` is used for the dev loop (fast, native TS execution,
no separate `ts-node` + loader configuration).

---

## ADR-003: HTTP layer — Express

**Status:** Accepted (Phase 1)

A minimal Express server backs the health/status endpoint created in Phase 1
and will later back the dashboard's REST API (Phase 12). Express was chosen
over a no-dependency `http` server for the small amount of routing/middleware
the dashboard phase will need, while staying far lighter than a full
framework. This is intentionally the only web framework decision made now;
authentication middleware, rate limiting, etc. are deferred to the phases
that need them (see `docs/SECURITY.md`).

---

## ADR-004: Logging — pino

**Status:** Accepted (Phase 1)

`pino` was chosen for structured JSON logging: low overhead, widely used in
Node backends, straightforward `redact` support to keep secrets out of logs,
and `pino-pretty` for readable local development output without affecting
production log format.

---

## ADR-005: Database — Supabase (Postgres), not wired up yet

**Status:** Accepted in principle (Phase 1); implementation deferred to Phase 3

Supabase was specified as a requirement and fits the project well: managed
Postgres with Row Level Security for the future dashboard, generous free
tier, and a straightforward JS/TS client. Phase 1 reserves the environment
variables (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`) and a `database`
field in the health-status response, but does **not** add
`@supabase/supabase-js` as a dependency yet or attempt any connection — doing
so before the schema (Phase 3) and group-config model (Phase 4) exist would
be premature and would misreport a "connected" status the app can't actually
back up. The health endpoint reports the database component as
`not_implemented` until Phase 3 lands.

---

## ADR-006: WhatsApp auth-state persistence — abstracted now, durable store deferred to Phase 3

**Status:** Accepted (Phase 2)

### Context

WhatsApp multi-device auth state (`creds` + the signal protocol key store)
must survive process restarts, or every restart would force a fresh QR
scan. Render's filesystem is ephemeral across deploys/restarts on typical
plans, so naively using Baileys' local-folder `useMultiFileAuthState` in
production would silently break exactly the "no QR after restart"
requirement this phase exists to satisfy.

Building the production-durable store now would mean reaching into Supabase
schema/implementation before Phase 3 — explicitly out of scope for Phase 2.

### Decision

Introduce an `AuthStateProvider` interface
(`src/whatsapp/auth/authStateProvider.ts`) that the connection manager
depends on exclusively:

```ts
interface AuthStateProvider {
  readonly kind: string;
  init(): Promise<void>;
  load(): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }>;
  hasExistingSession(): Promise<boolean>;
  clear(): Promise<void>;
}
```

Phase 2 ships exactly one implementation, `FileAuthStateProvider`, wrapping
Baileys' `useMultiFileAuthState` against `WHATSAPP_AUTH_DIR` — explicitly
**development-only**. `hasExistingSession()` is implemented by reading just
`creds.json`'s `registered` flag, without loading the full signal key
store, so start-up logging can say "reconnecting with an existing session"
vs "QR required" cheaply.

### What Phase 3 must provide for production

A second implementation of the same `AuthStateProvider` interface, backed
by Supabase/Postgres (or another durable, access-controlled store),
satisfying:

- **Durability** across Render restarts/redeploys (the whole point).
- **Encryption at rest** for the stored credentials/keys — this is
  effectively the keys to the linked WhatsApp account; a leaked service
  role key plus unencrypted auth rows would be equivalent to a stolen
  session. Exact mechanism (Postgres column-level encryption, pgcrypto, or
  application-level encryption before the write) is a Phase 3 design
  decision, not made here.
- **No logging of contents** — same requirement `FileAuthStateProvider`
  already meets (see docs/SECURITY.md); a Supabase-backed provider must
  never log the row contents, only metadata (e.g. "credentials updated").
- **Same interface, same semantics** for `hasExistingSession()` (cheap,
  doesn't require loading the full key store) and `clear()` (explicit/
  controlled only — see the connection manager's logout-vs-disconnect
  distinction in docs/ARCHITECTURE.md).
- **Access restricted to the bot process** — the service role key already
  satisfies this (never shipped to any client/dashboard bundle), but the
  table(s) holding auth state specifically should not be exposed through
  any future dashboard API, even to the owner, except perhaps a "clear
  session" action that goes through `requestLogout()` rather than direct
  row access.

Until Phase 3 lands, running this bot on Render means re-scanning a QR
after every restart/redeploy — a known, documented limitation, not a bug.

### Alternatives considered

- **Single-file auth state** (`useSingleFileAuthState` style): simpler but
  slower to read/write as the key store grows; Baileys itself recommends
  multi-file for anything beyond toy usage. Rejected for the same reason
  Phase 1's ADR-001 noted.
- **Environment-variable-encoded credentials**: would fit Render's env var
  storage, but credential material changes during normal operation
  (`creds.update` fires repeatedly), and env vars aren't writable at
  runtime — a non-starter.

---

## ADR-007: Deployment target — Render Web Service, Node runtime (no Dockerfile)

**Status:** Accepted (Phase 2B)

### Context

The project needs a public URL and a continuously-running process (not a
static site, not a serverless function — Baileys holds a long-lived
WebSocket open). The brief explicitly asked whether Node's native runtime
or Docker was the better fit, and to prefer the simpler option absent a
concrete reason otherwise.

### Decision

Render's native **Node runtime**, no Dockerfile. `render.yaml` (a Render
Blueprint) defines the service: `npm install && npm run build` to build,
`npm start` to run, `/health` as the health check path.

### Rationale

This project has no system-level dependency that would need a custom
container image — Baileys and every other dependency are pure JS (no
native compilation step, no system libraries, no non-Node runtime). A
Dockerfile would add a layer of build/maintenance surface (base image
choice, security patching, multi-stage build tuning) for zero functional
benefit here. If a future phase adds a dependency that genuinely needs
Docker (e.g. a native image-processing library for Phase 8's media
handling that isn't available as a prebuilt binary), this decision should
be revisited then, not preemptively.

### Why not Vercel

Vercel's primary model is serverless functions and static/edge hosting;
neither fits a process that must keep a persistent WebSocket connection to
WhatsApp open across requests. Render's "Web Service" (and Railway,
Fly.io, a plain VM, etc.) target exactly this always-on-process model, so
no redesign around Vercel was pursued. This was also an explicit
instruction in the brief, but it also happens to be the technically correct
call given the architecture.

### Plan tier

`render.yaml` specifies the **Starter** (paid) plan, not **Free**. Render's
free web-service tier spins down after ~15 minutes of no inbound HTTP
traffic and spins back up on the next request — which would silently kill
the long-lived WhatsApp socket on every spin-down. That defeats the
purpose of this phase. Documented plainly (not silently chosen) in
`docs/DEPLOYMENT.md`, with the free tier offered as an explicit, informed
downgrade for owners who just want to try the dashboard UI.

---

## ADR-008: Real-time dashboard updates — Server-Sent Events (SSE)

**Status:** Accepted (Phase 2B)

### Context

The pairing modal needs to show QR/status updates as they happen (QR
appears → scanned → connected) without the owner refreshing the page. Three
standard options: WebSocket, Server-Sent Events, or short polling.

### Decision

**Server-Sent Events**, one stream per account
(`GET /api/accounts/:id/events`), built on the connection manager's
existing `onUpdate()` subscriber list (added in this phase specifically to
support this).

### Rationale

- The data flow is **one-directional** (server → browser only); the
  browser never needs to push anything over this channel (pairing-code
  requests, account actions, etc. are ordinary authenticated POST/DELETE
  requests). WebSocket's bidirectionality would be unused complexity.
- SSE rides on a plain HTTP response (`Content-Type: text/event-stream`),
  so it inherits the existing cookie-based session auth for free — no
  separate handshake/auth scheme to design, unlike a WebSocket upgrade
  (which doesn't carry the same CSRF/origin protections and would need its
  own auth story).
- The browser's native `EventSource` handles reconnection automatically,
  which short polling would have to reimplement, and which a raw WebSocket
  client would also have to reimplement.
- Short polling was rejected as strictly worse here: either it polls
  aggressively (wasted requests, slower perceived updates) or infrequently
  (sluggish QR-scanned-to-connected feedback) — SSE gets push-like latency
  for free.

### Consequences

- A 20-second heartbeat comment (`: heartbeat\n\n`) is sent on each stream
  to keep intermediate proxies/load balancers from timing out an
  apparently-idle connection.
- Each open dashboard tab holds one HTTP connection per visible pairing
  modal for as long as it's open; this is negligible at the single-owner,
  few-accounts scale this phase targets, but would need revisiting if this
  became a multi-tenant product.
- The raw QR string is never sent over this channel — see ADR-009 and
  docs/SECURITY.md; it's rendered server-side into a PNG data URL first.

---

## ADR-009: Interim owner authentication — single shared password, server-side sessions

**Status:** Accepted (Phase 2B) — explicitly interim

### Context

The reference site (functional inspiration only, not copied — see the top
of this document) reportedly makes its pairing flow publicly reachable by
any visitor, which this project must not reproduce. Phase 2B needs _some_
barrier before the dashboard, but building a full multi-user auth system
(e.g. wiring up Supabase Auth) is Phase 3+ scope, not this phase's.

### Decision

A single environment variable, `DASHBOARD_ADMIN_PASSWORD`, checked against
the submitted login password with a constant-time, length-normalized
comparison (`sha256` both sides, then `crypto.timingSafeEqual`). On
success, an opaque random session token (32 bytes, `crypto.randomBytes`) is
stored **server-side only**, in an in-memory `Map` (`src/web/sessionStore.ts`),
and handed to the browser as an `HttpOnly`, `SameSite=Lax` cookie —
`Secure` additionally in production. A matching per-session CSRF token is
minted at the same time and embedded into the dashboard's HTML (`<meta
name="csrf-token">`) for the frontend to echo back on every mutating
request.

### Why these specific choices

- **No JWT / no signed cookie.** The cookie holds nothing but an
  unguessable random token; the server looks up the real session
  server-side. This avoids the entire class of JWT-specific pitfalls (alg
  confusion, exp handling, revocation difficulty) for a problem that
  doesn't need them — there's exactly one password, one role (owner), and
  revocation just means deleting a Map entry.
- **In-memory session store, not a database.** Consistent with this
  phase's "don't add persistence before it's needed" stance — and a
  genuine trade-off, not a shortcut: a process restart signs everyone out.
  Acceptable for a single-owner dashboard; documented, not hidden.
- **SameSite=Lax as the first CSRF line of defense**, a synchronizer CSRF
  token as the second. `Lax` alone already blocks cross-site POST/DELETE
  (cookies aren't attached to those regardless of origin); the token is
  defense in depth per the brief's explicit request, and makes the
  protection explicit/testable rather than relying solely on browser
  cookie-policy behavior.
- **Login rate limiting** (`src/web/loginRateLimiter.ts`): 5 failed
  attempts per 15-minute window per client IP, in-memory, same trade-off
  rationale as the session store.

### Explicitly interim

This is a placeholder appropriate for "one owner, early private
deployment" — not a multi-user auth system, not suitable if this product
ever has more than one admin. The documented upgrade path is **Supabase
Auth**, once Phase 3 brings Supabase into the project anyway; at that
point `DASHBOARD_ADMIN_PASSWORD` and the in-memory session store should be
retired in favor of real user accounts, hashed/salted credentials (or
OAuth), and database-backed sessions.

---

## ADR-010: Multi-account architecture — `AccountManager` registry

**Status:** Accepted (Phase 2B)

### Context

Phase 2 built `WhatsAppConnectionManager` around a single implicit
connection (`whatsappService.ts`, a singleton wrapping one manager). The
product goal is multiple WhatsApp accounts, each independently paired,
connected, and (eventually) configured. Retrofitting multi-account support
onto a hard-coded singleton later would mean rewriting the connection
layer's call sites throughout the app; the brief explicitly asked to avoid
that trap now.

### Decision

Replaced `whatsappService.ts` with `src/whatsapp/accountManager.ts`: a
registry (`Map<accountId, { label, createdAt, manager }>`) where each
account gets its own `WhatsAppConnectionManager` instance and its own
`FileAuthStateProvider` rooted at `${WHATSAPP_AUTH_DIR}/<accountId>/` (previously
just `WHATSAPP_AUTH_DIR` directly, for the one implicit account). The
account list itself (id/label/createdAt — never credentials) is persisted
as a small JSON manifest (`${WHATSAPP_AUTH_DIR}/accounts.json`) so the
dashboard's account cards survive a process restart, loaded back into
manager instances (which then attempt their own reconnect per Phase 2's
existing logic).

`connectionManager.ts` itself also gained, in this phase: `onUpdate()`
(subscriber list for SSE), `getPairingSnapshot()` (status + QR/pairing
code, strictly separate from `getStatus()` — see docs/SECURITY.md), and
`requestPairingCode()` (verified against Baileys 6.7.24's actual
implementation — see the ADR-001 update above).

### What's genuinely multi-account-ready vs. not yet

Ready now: any number of accounts can be created, paired, connected, and
removed independently through the registry and the dashboard; each has
fully independent connection state, auth storage, and reconnect behavior.

Not yet (explicitly deferred, not silently skipped):

- **Per-account bot configuration** (group rules, AI settings, etc.) —
  that's Phase 4+'s `group_settings` model, which will key off
  `account.id` once it exists, but doesn't exist yet in this phase.
- **`/health`'s single `whatsapp` field** still represents one aggregate
  status (prefers a connected account, else the first known account, else
  `disabled` — see `AccountManager.getAggregateStatus()`), not a per-account
  breakdown. `/health` was designed in Phase 2 around one connection and
  deliberately wasn't redesigned into a list in this phase — the
  dashboard's `/api/accounts` is the real per-account status source;
  `/health` stays a simple liveness/aggregate signal. Revisit if a future
  phase needs per-account health in automated monitoring.
- **The manifest is a flat file, not Supabase** — fine at today's scale
  (one owner, a handful of accounts), and explicitly not the Phase 3
  database work pulled forward.
