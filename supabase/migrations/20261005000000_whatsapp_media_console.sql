-- Owner Media Console / "Message Vault" (outgoing side): lets the
-- authenticated dashboard owner manually compose and send a WhatsApp
-- message (text, image, video, audio/voice note, or document) to a known
-- contact, a known group, or themselves ("Message Yourself"), distinct
-- from every automated send path (rule engine, moderation, commands, daily
-- summary, approvals) which only ever calls
-- WhatsAppConnectionManager.sendTextMessage()/sendMediaMessage() directly —
-- never through this table's writer. This table is therefore the
-- structural mechanism that keeps a manual owner send distinguishable from
-- automation: automation code has no reference to the repository that
-- writes it, so it cannot fabricate a "manual send" record even if it
-- wanted to disguise itself as one. See src/web/mediaConsoleRoutes.ts (the
-- only writer) and docs/SECURITY.md.
--
-- The actual sent media bytes are never stored in Postgres. When the send
-- succeeds, Baileys echoes the sent message back through the normal
-- `messages.upsert` pipeline with `fromMe: true`; the event pipeline (see
-- src/whatsapp/events/eventPipeline.ts) now stores and archives
-- `fromMe` messages the same way it does incoming ones, which is what
-- makes the actually-sent media later viewable (via whatsapp_media_archive,
-- keyed by whatsapp_message_id) and later recoverable if the owner
-- themselves deletes it ("Delete for Everyone") from this or another
-- device.

create table if not exists whatsapp_outbound_sends (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references whatsapp_accounts(id) on delete cascade,
  -- Client-generated idempotency key: a resubmitted/double-clicked send
  -- with the same request_id returns the original result instead of
  -- sending twice. See src/db/outboundSendsRepository.ts.
  request_id text not null,
  -- Exactly one of (contact_id, group_id) is set. "Send to myself" is
  -- represented as an ordinary contact row whose whatsapp_jid is the
  -- connected account's own JID (WhatsApp's "Message Yourself" chat is a
  -- normal private chat) — see mediaConsoleRoutes.ts's resolveDestination().
  contact_id uuid references whatsapp_contacts(id) on delete cascade,
  group_id uuid references whatsapp_groups(id) on delete cascade,
  destination_jid text not null,
  message_type text not null check (
    message_type in ('text', 'image', 'video', 'audio', 'voice_note', 'document')
  ),
  text_body text,
  caption text,
  view_once boolean not null default false,
  file_name text,
  mime_type text,
  file_size_bytes bigint,
  whatsapp_message_id text,
  -- 'pending' is written FIRST, before the WhatsApp send is even attempted
  -- — see mediaConsoleRoutes.ts. The unique (account_id, request_id)
  -- constraint then atomically rejects a concurrent duplicate submission
  -- of the same request_id BEFORE it can reach Baileys a second time; the
  -- row is updated to 'sent'/'failed' only after the send actually
  -- resolves. This is the real double-click/duplicate-submission guard —
  -- a client-side disabled button is only a convenience on top of it.
  status text not null check (status in ('pending', 'sent', 'failed')),
  error_message text,
  created_at timestamptz not null default now(),
  constraint whatsapp_outbound_sends_scope_check check (
    (contact_id is not null and group_id is null) or
    (contact_id is null and group_id is not null)
  ),
  unique (account_id, request_id)
);
alter table whatsapp_outbound_sends enable row level security;

create index if not exists whatsapp_outbound_sends_account_id_idx on whatsapp_outbound_sends(account_id);
create index if not exists whatsapp_outbound_sends_contact_id_idx on whatsapp_outbound_sends(contact_id);
create index if not exists whatsapp_outbound_sends_group_id_idx on whatsapp_outbound_sends(group_id);
create index if not exists whatsapp_outbound_sends_message_id_idx on whatsapp_outbound_sends(whatsapp_message_id);
