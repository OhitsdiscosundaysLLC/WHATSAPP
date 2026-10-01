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

**Status:** Accepted (Phase 2); the Phase 3 durable store this ADR deferred
is now implemented — see ADR-011.

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

**Resolved by ADR-011** — a second implementation of the same
`AuthStateProvider` interface, backed by Supabase/Postgres, satisfying:

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

Until Phase 3 lands — now shipped, see ADR-011 — running this bot on Render
without `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`/
`WHATSAPP_AUTH_ENCRYPTION_KEY` configured means re-scanning a QR after
every restart/redeploy (the `FileAuthStateProvider` fallback remains for
local development and for anyone who hasn't configured Supabase yet) — a
known, documented limitation, not a bug.

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
  database work pulled forward. **Resolved in Phase 3 / ADR-011**: the JSON
  manifest (`JsonManifestAccountStore`) remains the local-development
  implementation, but production now uses `SupabaseAccountStore` behind the
  same `AccountStore` interface, selected automatically alongside the
  Supabase-backed auth provider.

---

## ADR-011: Durable WhatsApp session persistence — Supabase-backed `AuthStateProvider` + `AccountStore`

**Status:** Accepted (Phase 3)

### Context

ADR-006 deferred the production-durable implementation of
`AuthStateProvider` to Phase 3, and ADR-010 deferred replacing the JSON
account manifest with a real database for the same reason. Both gaps have
the same root cause: Render's filesystem is ephemeral, so anything that
must survive a redeploy has to live somewhere else. This phase builds that
"somewhere else."

### Decision

**Storage backend: Supabase/Postgres**, accessed server-side only via
`@supabase/supabase-js` and the service role key (never shipped to any
client). Three tables — `whatsapp_accounts`, `whatsapp_auth_credentials`,
`whatsapp_auth_keys` — created by
`supabase/migrations/20261001120000_whatsapp_core.sql`. Full schema in
`docs/DATABASE.md`.

**Two new implementations, selected together, of existing interfaces:**

- `SupabaseAuthStateProvider` implements `AuthStateProvider` exactly as
  `FileAuthStateProvider` does — the connection manager depends on the
  interface only, so it cannot tell which one it's talking to.
- `SupabaseAccountStore` implements a newly-extracted `AccountStore`
  interface (`src/whatsapp/accountStore.ts`) alongside
  `JsonManifestAccountStore` (the Phase 2B manifest logic, extracted
  unchanged into the same interface).
- `src/whatsapp/authStorageMode.ts`'s `resolveAuthStorageMode()` is the
  single place that decides which pair gets used, based purely on whether
  `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` are both set. If they're set
  but `WHATSAPP_AUTH_ENCRYPTION_KEY` is missing/malformed, it throws rather
  than silently falling back to the file-backed pair — a misconfiguration
  must be loud, never mistaken for working durability.

**Signal key store shape**: Baileys' `SignalKeyStore.get`/`set`/`clear`
operate on a category (`pre-key`, `session`, `sender-key`,
`sender-key-memory`, `app-state-sync-key`, `app-state-sync-version`) and a
map of `key_id → value`. `whatsapp_auth_keys` mirrors this directly — one
row per `(account_id, category, key_id)`, composite primary key — rather
than collapsing it into a single JSON blob per account, because Baileys
reads/writes individual keys by id (e.g. fetching a handful of pre-keys),
and a row-per-key layout serves that access pattern without reading or
rewriting unrelated keys.

**Serialization**: verified against the installed `@whiskeysockets/baileys`
6.7.24 source (`lib/Utils/use-multi-file-auth-state.js`), not assumed.
Every category round-trips through Baileys' own `BufferJSON.replacer`/
`.reviver` (so `Buffer`/`Uint8Array` fields survive JSON serialization
exactly as `useMultiFileAuthState` already relies on), with exactly one
additional category-specific step: `app-state-sync-key` values are passed
through `proto.Message.AppStateSyncKeyData.fromObject()` after the generic
JSON round-trip, mirroring what Baileys' reference implementation does —
not an invented step (`src/whatsapp/auth/baileysSerialization.ts`).

**Encryption**: AES-256-GCM, applied in the application layer before any
value reaches Supabase — see docs/SECURITY.md's "Durable WhatsApp
auth-state persistence" section for the full model (key format/validation,
per-operation random IVs, auth-tag verification on decrypt, key-loss
consequences). Ciphertext/IV/auth-tag are stored as base64 `text` columns,
not `bytea` — this sidesteps depending on exactly how PostgREST represents
binary columns over JSON, which the project has no way to verify short of
testing against a live instance; base64 text round-trips through JSON
unambiguously regardless.

**Database access control**: RLS enabled on all three tables, with
**zero** policies for `anon`/`authenticated` — a deliberate default-deny
posture. Only the service role key, used exclusively server-side, can read
or write these tables.

**Failure handling**: every `SupabaseAuthStateProvider` method throws on a
genuine query failure — the only path that returns a blank, unregistered
identity is a _successful_ query finding no row. This specifically
prevents a transient Supabase outage from being misread as "no session
exists," which would otherwise risk an unnecessary new QR prompt or an
uncontrolled reconnect loop. The one deliberate exception is
`AccountStore.touchLastConnected()`, which logs and swallows failures
rather than throwing, since it's a best-effort annotation that must never
affect the live WhatsApp connection it describes.

### Alternatives considered

- **Supabase Storage (object storage) instead of Postgres rows**: rejected
  — the signal key store is many small, individually-addressed values
  (lookup by category + id), which maps naturally onto relational rows with
  a composite key and an index, not onto object storage's file-like access
  pattern.
- **`pgcrypto` / column-level database encryption** instead of
  application-level encryption: rejected because it would mean the
  database (and anyone with the service role key or direct SQL access)
  could decrypt the data, defeating the point of encrypting credentials
  that are "equivalent to the keys to the linked WhatsApp account" (ADR-006
  / docs/SECURITY.md). Application-level encryption means only this
  process, holding `WHATSAPP_AUTH_ENCRYPTION_KEY`, can ever produce
  plaintext.
- **One JSON blob per account** (entire signal key store serialized as a
  single `jsonb`/encrypted column) instead of one row per key: rejected —
  it would mean reading and rewriting the entire key store on every single
  key update, and losing the composite-PK-enforced per-account isolation
  property in favor of an isolation property that depends on application
  code getting a `WHERE account_id = ...` right every time.
- **Database trigger for `updated_at`**: considered, but this project's
  tooling for applying `CREATE FUNCTION`/`CREATE TRIGGER` statements proved
  unreliable in this environment (repeated timeouts with no underlying
  database lock contention). Rather than fight the tooling, `updated_at` is
  set explicitly by application code on every write — one less moving part,
  and no dependency on a server-side trigger function existing and staying
  in sync with the application's understanding of when a row changed.

---

## ADR-012: Event pipeline + deterministic rule engine (Phase 4+5)

**Status:** Accepted (Phase 4+5)

### Context

Phase 3 made the WhatsApp connection durable; the account still did nothing
with messages. The product goal, stated explicitly, is **not** "every
message → OpenAI → response" — it's a configurable pipeline: event →
normalize → identify context → load configuration → evaluate rules →
decide whether AI is needed (not yet — Phase 6) → act → audit. This ADR
records the decisions behind that pipeline, built without modifying the
Phase 1-3 connection/auth layers.

### Decision: connection manager stays dumb, fans out raw events

`WhatsAppConnectionManager` gained exactly three things: an `onMessage`
callback (fired per `WAMessage` from `messages.upsert`), an
`onGroupsDiscovered` callback (fired from `groups.upsert`/`groups.update`
and once per connect via Baileys' own `groupFetchAllParticipating()` — not
a hand-rolled "list all groups" call), and `sendTextMessage()`. It still
does zero content interpretation — that was a hard requirement to avoid
re-architecting a class that was already correct and already tested.
Interpretation lives entirely in new modules (`src/whatsapp/events/`,
`src/whatsapp/groups/`, `src/rules/`) that depend on the connection
manager, never the reverse.

### Decision: two separate idempotency mechanisms, not one

- `whatsapp_processed_events` — unconditional, for every inbound message,
  independent of any group's settings. This is what "WhatsApp events may
  be delivered more than once" (product spec) actually requires: a
  redelivered event must never be evaluated twice, whether or not the
  group it's in has monitoring or the bot turned on.
- `rule_matches.fired` — a separate, atomic compare-and-set
  (`UPDATE ... WHERE fired = false`), because "fires exactly once" is a
  property of a _rule's outcome_ for a given target message, not of the
  _message_ that happened to push it over the threshold. Conflating the
  two would mean the 5th qualifying response (the one that crosses the
  threshold) gets the same dedup treatment as the 6th, 7th, ... — which
  works, but obscures that these are different guarantees for different
  failure modes (duplicate delivery vs. a genuine race between two
  concurrent evaluations of the same target message).

### Decision: distinct-sender counting is a schema-level guarantee

`rule_match_responders`'s primary key is `(rule_match_id, sender_jid)`.
"Five responses from ONE person must NOT count as five people" (product
spec #13) is enforced by Postgres rejecting/no-opping a duplicate insert,
not by an application-level `Set` that could in principle be constructed
wrong. `RuleStateRepository.countDistinctResponders()` is then just "how
many rows exist" — nothing clever, because the cleverness already happened
at the schema level.

### Decision: `ResponseClassifier` is an interface, not a function call into OpenAI

The product spec is explicit that Phase 5 must implement deterministic
qualification first and must not tightly couple the rule engine to AI.
`src/rules/classifiers/responseClassifier.ts` defines
`ResponseClassifier { kind, classify(text, config): Promise<boolean> }`;
`DeterministicResponseClassifier` is the only implementation today
(exact/contains/keyword, case-insensitive). `RuleEngine` is constructed
with a classifier instance via dependency injection — it has no import of,
or awareness of, any AI provider. A future `AIResponseClassifier`
satisfies the exact same interface; nothing in `ruleEngine.ts` needs to
change when it's added.

### Decision: target-message identification is reply-only, for now

`response_threshold.config.targetMessageMatch` is a fixed literal
`'quoted'` (validated by `src/rules/ruleConfig.ts`'s zod schema) rather
than an open string. A qualifying response must carry Baileys'
`contextInfo.stanzaId` pointing at the message it's replying to — "use
WhatsApp quoted/reply metadata when available" (spec #12) is read as a
requirement, not a suggestion, because without it there's no reliable way
to know which of potentially many recent messages a short reply like
"congrats" is actually responding to. The field is a fixed literal rather
than an enum of one so that a second matching strategy (e.g. "any message
in the last N minutes," for groups that don't reply-thread) can be added
later as a genuinely new, explicit option — not inferred from absence.

### Decision: groups/rules/messages/audit storage is Supabase-only

Same reasoning as ADR-011's auth-state/account-storage split: there is no
local-file equivalent for `whatsapp_groups`, `group_rules`,
`whatsapp_messages`, or the audit tables. Running this phase's features in
local development without Supabase configured means the Groups and
Activity dashboard pages show a plain "requires Supabase" message
(`503 supabase_not_configured` from `src/web/groupRoutes.ts` /
`activityRoutes.ts`) rather than a parallel JSON-file implementation of a
relational, multi-table, foreign-key-linked schema — building and
maintaining that parallel implementation was judged not worth it for a
feature set that only makes sense once an account is actually running in
production.

### Decision: safe defaults are enforced at the point of row creation, not just documented

`GroupsRepository.ensureSettings()` is the only path that creates a
`group_settings` row, and it always writes
`DEFAULT_GROUP_SETTINGS` (every boolean `false`) — called automatically
the moment a group is discovered, before the owner has looked at it. "The
owner explicitly enables groups" (spec) is therefore not just a documented
intention; a newly discovered group is structurally incapable of having
automation on, because no code path exists that creates its settings row
any other way.

### Decision: `bot_enabled` gates rule evaluation; `monitoring_enabled` gates storage — independently

These are deliberately two separate toggles rather than one, because they
answer different questions: "should this group's messages be archived?"
(monitoring — useful on its own, e.g. ahead of a future deleted-message
archive feature) vs. "should rules evaluate and potentially act in this
group?" (bot). A group can have monitoring on with the bot off (build a
message history without risking an automated send), or the bot on without
monitoring (rules run, but the full message archive isn't kept) —
`src/whatsapp/events/eventPipeline.ts` checks them as two independent
`if` statements, not a combined flag.

### Alternatives considered

- **AI-first classification** ("every message → OpenAI → response"):
  explicitly rejected by the product spec itself — see "Why AI is not in
  the hot path" in docs/ARCHITECTURE.md.
- **A single `message.received` audit event for every incoming group
  message, regardless of settings**: rejected as default behavior — it
  would silently grow `whatsapp_audit_logs` for every group the account is a member
  of, including ones the owner has never configured, undermining "safe
  defaults" in spirit even though it wouldn't automate anything. Audit
  events are recorded when `bot_enabled` is true (the group is actually
  being watched), not unconditionally.
- **Storing the full raw `WAMessage` protobuf in `whatsapp_messages`**:
  rejected per the product spec's own instruction ("do not unnecessarily
  store giant raw Baileys payloads") and docs/SECURITY.md's general
  data-minimization stance; only the normalized fields are persisted.
