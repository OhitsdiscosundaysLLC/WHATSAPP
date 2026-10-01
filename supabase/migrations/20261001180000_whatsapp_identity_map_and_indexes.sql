-- Production hardening pass: WhatsApp identity resolution (@lid <-> phone
-- number) + four missing foreign-key indexes flagged by Supabase's
-- performance advisor on this project's own tables.
--
-- Purely additive. Checked against information_schema for collisions
-- before applying (none — see the hardening session's audit).

-- ---------------------------------------------------------------------
-- whatsapp_identity_map
-- ---------------------------------------------------------------------
-- Durable @lid <-> <number>@s.whatsapp.net mapping, per account. Modern
-- WhatsApp/Baileys can address a participant by an anonymous `@lid`
-- identity instead of their phone-number JID; owner/admin command
-- authorization must work either way (see
-- src/whatsapp/identity/identityResolver.ts). Populated opportunistically
-- whenever Baileys gives us both forms for the same person — a message
-- key's `participantPn`/`participantLid` (or `senderPn`/`senderLid` for a
-- non-group message), or a discovered group's participant list, which
-- Baileys' `Contact` type can carry both `.lid` and `.jid` on. Never
-- guessed at or inferred from a display name.
create table if not exists public.whatsapp_identity_map (
  account_id uuid not null references public.whatsapp_accounts(id) on delete cascade,
  lid_jid text not null,
  phone_jid text not null,
  updated_at timestamptz not null default now(),
  primary key (account_id, lid_jid)
);

create index if not exists whatsapp_identity_map_phone_idx
  on public.whatsapp_identity_map (account_id, phone_jid);

alter table public.whatsapp_identity_map enable row level security;

-- ---------------------------------------------------------------------
-- Missing foreign-key covering indexes (Supabase performance advisor)
-- ---------------------------------------------------------------------
create index if not exists whatsapp_ai_usage_rule_id_idx
  on public.whatsapp_ai_usage (rule_id);

create index if not exists whatsapp_audit_logs_account_id_idx
  on public.whatsapp_audit_logs (account_id);

create index if not exists whatsapp_call_events_group_id_idx
  on public.whatsapp_call_events (group_id);

create index if not exists whatsapp_media_archive_account_id_idx
  on public.whatsapp_media_archive (account_id);
