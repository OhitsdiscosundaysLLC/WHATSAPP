import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface RecordMediaArchiveInput {
  accountId: string;
  /** Exactly one of groupId/contactId is set — group media vs. private-chat media. */
  groupId: string | undefined;
  contactId: string | undefined;
  whatsappMessageId: string;
  senderJid: string;
  isViewOnce: boolean;
  storagePath: string;
  mimeType: string;
  fileSizeBytes: number;
  sha256: string | undefined;
}

export interface MediaArchiveRecord {
  id: string;
  groupId: string | undefined;
  contactId: string | undefined;
  whatsappMessageId: string;
  senderJid: string;
  isViewOnce: boolean;
  storagePath: string;
  mimeType: string;
  fileSizeBytes: number;
  createdAt: string;
}

interface MediaArchiveRow {
  id: string;
  group_id: string | null;
  contact_id: string | null;
  whatsapp_message_id: string;
  sender_jid: string;
  is_view_once: boolean;
  storage_path: string;
  mime_type: string;
  file_size_bytes: number;
  created_at: string;
}

function fromRow(row: MediaArchiveRow): MediaArchiveRecord {
  return {
    id: row.id,
    groupId: row.group_id ?? undefined,
    contactId: row.contact_id ?? undefined,
    whatsappMessageId: row.whatsapp_message_id,
    senderJid: row.sender_jid,
    isViewOnce: row.is_view_once,
    storagePath: row.storage_path,
    mimeType: row.mime_type,
    fileSizeBytes: row.file_size_bytes,
    createdAt: row.created_at,
  };
}

/**
 * Metadata for archived media — the bytes themselves live in the private
 * `whatsapp-media` Supabase Storage bucket (never a Postgres column). See
 * src/whatsapp/archive/viewOnceHandler.ts for the only writer today.
 */
export class MediaArchiveRepository {
  constructor(private readonly supabase: SupabaseClient) {}

  async record(input: RecordMediaArchiveInput): Promise<void> {
    const { error } = await this.supabase.from('whatsapp_media_archive').insert({
      id: randomUUID(),
      account_id: input.accountId,
      group_id: input.groupId ?? null,
      contact_id: input.contactId ?? null,
      whatsapp_message_id: input.whatsappMessageId,
      sender_jid: input.senderJid,
      is_view_once: input.isViewOnce,
      storage_path: input.storagePath,
      mime_type: input.mimeType,
      file_size_bytes: input.fileSizeBytes,
      sha256: input.sha256 ?? null,
      created_at: new Date().toISOString(),
    });
    if (error) {
      throw new Error(`Failed to record archived media: ${error.message}`);
    }
  }

  async listByGroup(groupId: string, limit = 50): Promise<MediaArchiveRecord[]> {
    const { data, error } = await this.supabase
      .from('whatsapp_media_archive')
      .select(
        'id, group_id, contact_id, whatsapp_message_id, sender_jid, is_view_once, storage_path, mime_type, file_size_bytes, created_at',
      )
      .eq('group_id', groupId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) {
      throw new Error(`Failed to list archived media: ${error.message}`);
    }
    return (data ?? []).map((row) => fromRow(row as MediaArchiveRow));
  }

  async listByContact(contactId: string, limit = 50): Promise<MediaArchiveRecord[]> {
    const { data, error } = await this.supabase
      .from('whatsapp_media_archive')
      .select(
        'id, group_id, contact_id, whatsapp_message_id, sender_jid, is_view_once, storage_path, mime_type, file_size_bytes, created_at',
      )
      .eq('contact_id', contactId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) {
      throw new Error(`Failed to list archived media: ${error.message}`);
    }
    return (data ?? []).map((row) => fromRow(row as MediaArchiveRow));
  }

  /**
   * Looks up whether a specific WhatsApp message already has archived media
   * — used at REVOKE time (src/whatsapp/archive/deletedMessageHandler.ts) to
   * tell the owner a deleted message's media is still viewable, without a
   * full table scan (see `whatsapp_media_archive_message_lookup_idx`).
   */
  async findByMessageId(
    accountId: string,
    whatsappMessageId: string,
  ): Promise<MediaArchiveRecord | undefined> {
    const { data, error } = await this.supabase
      .from('whatsapp_media_archive')
      .select(
        'id, group_id, contact_id, whatsapp_message_id, sender_jid, is_view_once, storage_path, mime_type, file_size_bytes, created_at',
      )
      .eq('account_id', accountId)
      .eq('whatsapp_message_id', whatsappMessageId)
      .maybeSingle();
    if (error) {
      throw new Error(`Failed to look up archived media: ${error.message}`);
    }
    return data ? fromRow(data as MediaArchiveRow) : undefined;
  }
}
