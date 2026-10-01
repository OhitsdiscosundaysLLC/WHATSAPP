import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface RecordMediaArchiveInput {
  accountId: string;
  groupId: string;
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
  groupId: string;
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
  whatsapp_message_id: string;
  sender_jid: string;
  is_view_once: boolean;
  storage_path: string;
  mime_type: string;
  file_size_bytes: number;
  created_at: string;
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
      group_id: input.groupId,
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
        'id, group_id, whatsapp_message_id, sender_jid, is_view_once, storage_path, mime_type, file_size_bytes, created_at',
      )
      .eq('group_id', groupId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) {
      throw new Error(`Failed to list archived media: ${error.message}`);
    }
    return (data ?? []).map((row) => {
      const r = row as MediaArchiveRow;
      return {
        id: r.id,
        groupId: r.group_id ?? '',
        whatsappMessageId: r.whatsapp_message_id,
        senderJid: r.sender_jid,
        isViewOnce: r.is_view_once,
        storagePath: r.storage_path,
        mimeType: r.mime_type,
        fileSizeBytes: r.file_size_bytes,
        createdAt: r.created_at,
      };
    });
  }
}
