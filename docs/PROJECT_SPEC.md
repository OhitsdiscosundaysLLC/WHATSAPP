# Project Specification

## What this is

A configurable WhatsApp automation bot that connects to a personal WhatsApp
account and, per group (and optionally per DM contact), applies owner-defined
rules to decide whether and how to respond — using an LLM only when a rule
actually needs one. It also offers deleted-message archiving (within the
limits WhatsApp's protocol allows), configurable view-once media handling,
configurable missed-call auto-replies, moderation actions, a WhatsApp-native
command interface, and — eventually — a web dashboard.

This document describes this project only. It was not derived from, and does
not describe, any other WhatsApp bot project.

## Goals

1. **Per-group isolation.** Every group has independent configuration. Bot
   behavior in one group must never leak into another. Bots are **off by
   default** in every group until explicitly enabled.
2. **Rule-driven, not AI-driven.** A rule engine decides whether a given
   event needs a response at all, and whether answering that question needs
   AI. Most events should resolve without ever calling OpenAI.
3. **Owner-defined behavior.** The owner can describe, in plain language or
   structured config, what the bot should do in a specific group (e.g. "if 5
   different people react positively to an announcement, acknowledge it
   once"). That becomes a persisted, auditable rule — not a standing
   instruction applied everywhere.
4. **Honesty about platform limits.** Features constrained by WhatsApp's
   protocol or the chosen library (deleted-message recovery, view-once,
   calls) are implemented to the actual extent possible and their limits are
   documented and surfaced, not hidden.
5. **Auditable and idempotent.** Every automated action is traceable to the
   event and rule that caused it. Duplicate WhatsApp events must never cause
   duplicate actions.
6. **Secure by default.** Secrets live only in environment variables.
   Dangerous actions (moderation, owner commands) require explicit
   permission checks. Private-chat automation is opt-in, never default-on.

## Non-goals (for now)

- Supporting WhatsApp Business / Cloud API — this targets a regular personal
  account via a web-protocol client library.
- Multi-tenant hosting (running the bot for WhatsApp accounts other than the
  owner's). The architecture doesn't preclude it later, but it isn't a
  current requirement.
- A polished dashboard UI. The dashboard (Phase 12) starts as a REST API;
  UI work is out of scope until the API exists.

## Primary user

The project owner, who:

- Connects their own WhatsApp account to the bot.
- Enables/configures automation per group from WhatsApp commands and/or
  (eventually) the dashboard.
- Is the only party who can grant owner/admin-level permissions.

## High-level behavior flow

```
WhatsApp Event
  → Event Normalization        (shape every event into an internal type)
  → Message/Event Storage      (Supabase, idempotent on WhatsApp message/event id)
  → Rule Engine                (per-group config decides if anything applies)
  → AI only if a matched rule requires it
  → Action Executor            (reply, react, moderate, archive, ...)
  → WhatsApp
  → Action recorded             (audit log)
```

See `docs/ARCHITECTURE.md` for the component-level breakdown and
`docs/DATABASE.md` for how this flow is persisted.

## Phases

See `docs/DEVELOPMENT_PLAN.md` for the full phase breakdown. This document
(Phase 1) covers project foundation only: tooling, docs, configuration
loading, logging, and a health/status endpoint. No WhatsApp connection, no
database connection, and no AI calls are implemented yet.
