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

## What Phase 1 actually enforces today

Phase 1 ships no WhatsApp connection, no database connection, and no AI
calls — so most of the above is forward-looking design, not yet enforced
code. What _is_ true today:

- Config loading never logs secret values (`src/config/config.ts`,
  `src/services/logger.ts`).
- `.gitignore` excludes `.env` and any future local auth/media/session
  directories.
- The health endpoint reports real component status rather than claiming
  integrations work before they're implemented.
