import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

export type OutboundMessageType = 'text' | 'image' | 'video' | 'audio' | 'voice_note' | 'document';
export type OutboundSendStatus = 'pending' | 'sent' | 'failed';

export interface ReserveOutboundSendInput {
  accountId: string;
  requestId: string;
  /** Exactly one of groupId/contactId is set — see migration's scope check. */
  groupId: string | undefined;
  contactId: string | undefined;
  destinationJid: string;
  messageType: OutboundMessageType;
  textBody: string | undefined;
  caption: string | undefined;
  viewOnce: boolean;
  fileName: string | undefined;
  mimeType: string | undefined;
  fileSizeBytes: number | undefined;
}

export interface OutboundSendRecord {
  id: string;
  accountId: string;
  requestId: string;
  groupId: string | undefined;
  contactId: string | undefined;
  destinationJid: string;
  messageType: OutboundMessageType;
  textBody: string | undefined;
  caption: string | undefined;
  viewOnce: boolean;
  fileName: string | undefined;
  mimeType: string | undefined;
  fileSizeBytes: number | undefined;
  whatsappMessageId: string | undefined;
  status: OutboundSendStatus;
  errorMessage: string | undefined;
  createdAt: string;
}

interface OutboundSendRow {
  id: string;
  account_id: string;
  request_id: string;
  group_id: string | null;
  contact_id: string | null;
  destination_jid: string;
  message_type: OutboundMessageType;
  text_body: string | null;
  caption: string | null;
  view_once: boolean;
  file_name: string | null;
  mime_type: string | null;
  file_size_bytes: number | null;
  whatsapp_message_id: string | null;
  status: OutboundSendStatus;
  error_message: string | null;
  created_at: string;
}

function fromRow(row: OutboundSendRow): OutboundSendRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    requestId: row.request_id,
    groupId: row.group_id ?? undefined,
    contactId: row.contact_id ?? undefined,
    destinationJid: row.destination_jid,
    messageType: row.message_type,
    textBody: row.text_body ?? undefined,
    caption: row.caption ?? undefined,
    viewOnce: row.view_once,
    fileName: row.file_name ?? undefined,
    mimeType: row.mime_type ?? undefined,
    fileSizeBytes: row.file_size_bytes ?? undefined,
    whatsappMessageId: row.whatsapp_message_id ?? undefined,
    status: row.status,
    errorMessage: row.error_message ?? undefined,
    createdAt: row.created_at,
  };
}

const SELECT_COLUMNS =
  'id, account_id, request_id, group_id, contact_id, destination_jid, message_type, text_body, caption, view_once, file_name, mime_type, file_size_bytes, whatsapp_message_id, status, error_message, created_at';

/**
 * "Message Vault" (outgoing side): every manual send the Owner Media
 * Console (src/web/mediaConsoleRoutes.ts) has made, success or failure.
 * The only writer is that route module — no automation code path
 * (rule engine, moderation, commands, daily summary, approvals) holds a
 * reference to this repository, which is what keeps a manual owner send
 * structurally distinguishable from automation (see the migration's doc
 * comment and docs/SECURITY.md). Never stores media bytes — those live in
 * the private `whatsapp-media` Supabase Storage bucket once the sent
 * message round-trips back through the event pipeline's `fromMe`
 * handling (src/whatsapp/events/eventPipeline.ts), the same archive every
 * other message uses.
 */
export class OutboundSendsRepository {
  constructor(private readonly supabase: SupabaseClient) {}

  /**
   * Step 1 of the send flow (see mediaConsoleRoutes.ts): atomically
   * reserves `(account_id, request_id)` with `status: 'pending'` BEFORE
   * the WhatsApp send is even attempted. A concurrent duplicate
   * submission of the same `requestId` fails this insert with a Postgres
   * `23505` unique_violation — surfaced here as `undefined` — which the
   * caller must treat as "already in flight, do not send again," never
   * as a generic error. This is the real double-click/duplicate-
   * submission guard; the client disabling its Send button is only a
   * convenience on top of it.
   */
  async reserve(input: ReserveOutboundSendInput): Promise<OutboundSendRecord | undefined> {
    const { data, error } = await this.supabase
      .from('whatsapp_outbound_sends')
      .insert({
        id: randomUUID(),
        account_id: input.accountId,
        request_id: input.requestId,
        group_id: input.groupId ?? null,
        contact_id: input.contactId ?? null,
        destination_jid: input.destinationJid,
        message_type: input.messageType,
        text_body: input.textBody ?? null,
        caption: input.caption ?? null,
        view_once: input.viewOnce,
        file_name: input.fileName ?? null,
        mime_type: input.mimeType ?? null,
        file_size_bytes: input.fileSizeBytes ?? null,
        whatsapp_message_id: null,
        status: 'pending',
        error_message: null,
        created_at: new Date().toISOString(),
      })
      .select(SELECT_COLUMNS)
      .single();
    if (error) {
      if (error.code === '23505') return undefined;
      throw new Error(`Failed to reserve outbound send: ${error.message}`);
    }
    return fromRow(data as OutboundSendRow);
  }

  /** Step 2: finalizes a reserved row once the actual WhatsApp send has resolved (success or failure). */
  async finalize(
    id: string,
    result:
      | { status: 'sent'; whatsappMessageId: string | undefined }
      | { status: 'failed'; errorMessage: string },
  ): Promise<void> {
    const { error } = await this.supabase
      .from('whatsapp_outbound_sends')
      .update(
        result.status === 'sent'
          ? { status: 'sent', whatsapp_message_id: result.whatsappMessageId ?? null }
          : { status: 'failed', error_message: result.errorMessage },
      )
      .eq('id', id);
    if (error) {
      throw new Error(`Failed to finalize outbound send: ${error.message}`);
    }
  }

  async findByRequestId(
    accountId: string,
    requestId: string,
  ): Promise<OutboundSendRecord | undefined> {
    const { data, error } = await this.supabase
      .from('whatsapp_outbound_sends')
      .select(SELECT_COLUMNS)
      .eq('account_id', accountId)
      .eq('request_id', requestId)
      .maybeSingle();
    if (error) {
      throw new Error(`Failed to look up outbound send: ${error.message}`);
    }
    return data ? fromRow(data as OutboundSendRow) : undefined;
  }

  /** Not account-scoped by default — same single-owner-across-accounts precedent as src/web/inboxRoutes.ts. */
  async list(accountId: string | undefined, limit = 50): Promise<OutboundSendRecord[]> {
    let query = this.supabase
      .from('whatsapp_outbound_sends')
      .select(SELECT_COLUMNS)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (accountId) {
      query = query.eq('account_id', accountId);
    }
    const { data, error } = await query;
    if (error) {
      throw new Error(`Failed to list outbound sends: ${error.message}`);
    }
    return (data ?? []).map((row) => fromRow(row as OutboundSendRow));
  }
}
