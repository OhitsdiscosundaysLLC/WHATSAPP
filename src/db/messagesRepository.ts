import type { SupabaseClient } from '@supabase/supabase-js';
import type { NormalizedMessageEvent } from '../whatsapp/events/messageNormalizer';

/**
 * Two distinct concerns, deliberately kept separate (see
 * supabase/migrations/20261001140000_whatsapp_groups_rules.sql):
 *
 *  - `markProcessed()` — an always-on idempotency gate for EVERY inbound
 *    message, regardless of any group's monitoring setting. WhatsApp/
 *    Baileys can redeliver the same event; this must never cause a
 *    duplicate action.
 *  - `store()` — the optional, fuller normalized archive, written only for
 *    groups with `monitoring_enabled = true`.
 */
export class MessagesRepository {
  constructor(private readonly supabase: SupabaseClient) {}

  /**
   * Returns `true` if this is the first time we've seen this exact message
   * (and records it so it won't be again), `false` if we've already
   * processed it — callers must stop here on `false` rather than re-running
   * storage/rule evaluation.
   */
  async markProcessed(event: NormalizedMessageEvent): Promise<boolean> {
    const { error } = await this.supabase.from('whatsapp_processed_events').insert({
      account_id: event.accountId,
      chat_jid: event.chatJid,
      whatsapp_message_id: event.whatsappMessageId,
      processed_at: new Date().toISOString(),
    });

    if (!error) return true;

    // Postgres unique_violation — this exact (account, chat, message id)
    // was already recorded. Not a real error; this IS the dedup signal.
    if (error.code === '23505') return false;

    throw new Error(`Failed to record processed WhatsApp event: ${error.message}`);
  }

  /**
   * Marks a previously-stored message as deleted (WhatsApp "delete for
   * everyone" / revocation — see docs/DECISIONS.md ADR-001 on why "delete
   * for me" can never reach this method at all). Returns `true` if a
   * matching row was found and updated, `false` if this message was never
   * stored (e.g. monitoring was off when it originally arrived, or it
   * arrived before this account was connected) — callers should not treat
   * `false` as an error, just as "nothing to archive."
   */
  async markDeleted(
    accountId: string,
    chatJid: string,
    whatsappMessageId: string,
  ): Promise<boolean> {
    const { data, error } = await this.supabase
      .from('whatsapp_messages')
      .update({ deleted: true, deleted_at: new Date().toISOString() })
      .eq('account_id', accountId)
      .eq('chat_jid', chatJid)
      .eq('whatsapp_message_id', whatsappMessageId)
      .select('id');
    if (error) {
      throw new Error(`Failed to mark WhatsApp message deleted: ${error.message}`);
    }
    return Array.isArray(data) && data.length > 0;
  }

  /** Stores a normalized message — only call this when monitoring is enabled for its group/contact. */
  async store(
    event: NormalizedMessageEvent,
    scope: { groupId?: string; contactId?: string },
  ): Promise<void> {
    const { error } = await this.supabase.from('whatsapp_messages').insert({
      account_id: event.accountId,
      group_id: scope.groupId ?? null,
      contact_id: scope.contactId ?? null,
      chat_jid: event.chatJid,
      whatsapp_message_id: event.whatsappMessageId,
      sender_jid: event.senderJid,
      from_me: event.fromMe,
      message_type: event.messageType,
      text_content: event.text ?? null,
      quoted_whatsapp_message_id: event.quotedWhatsappMessageId ?? null,
      created_at: event.timestamp,
    });

    // A duplicate insert here (23505) is harmless and expected if this
    // event was somehow stored twice via a different path — the
    // idempotency gate above is what actually prevents double-processing.
    if (error && error.code !== '23505') {
      throw new Error(`Failed to store WhatsApp message: ${error.message}`);
    }
  }

  /** Recently deleted (archived) messages for a group — the dashboard's Deleted Messages view. */
  async listDeletedByGroup(groupId: string, limit = 50): Promise<DeletedMessageRecord[]> {
    const { data, error } = await this.supabase
      .from('whatsapp_messages')
      .select('id, sender_jid, message_type, text_content, created_at, deleted_at')
      .eq('group_id', groupId)
      .eq('deleted', true)
      .order('deleted_at', { ascending: false })
      .limit(limit);
    if (error) {
      throw new Error(`Failed to list deleted WhatsApp messages: ${error.message}`);
    }
    return (data ?? []).map((row) => {
      const r = row as {
        id: string;
        sender_jid: string;
        message_type: string;
        text_content: string | null;
        created_at: string;
        deleted_at: string | null;
      };
      return {
        id: r.id,
        senderJid: r.sender_jid,
        messageType: r.message_type,
        textContent: r.text_content ?? undefined,
        createdAt: r.created_at,
        deletedAt: r.deleted_at ?? undefined,
      };
    });
  }

  /** Purges archived text content for deleted messages past a group's retention window. Never deletes the row itself (deletion metadata/audit value stays). */
  async purgeExpiredDeletedContent(groupId: string, olderThan: Date): Promise<number> {
    const { data, error } = await this.supabase
      .from('whatsapp_messages')
      .update({ text_content: null })
      .eq('group_id', groupId)
      .eq('deleted', true)
      .lte('deleted_at', olderThan.toISOString())
      .select('id');
    if (error) {
      throw new Error(`Failed to purge expired deleted-message content: ${error.message}`);
    }
    return Array.isArray(data) ? data.length : 0;
  }

  /** Recently deleted (archived) messages for a private contact — the dashboard's per-contact Deleted Messages view. */
  async listDeletedByContact(contactId: string, limit = 50): Promise<DeletedMessageRecord[]> {
    const { data, error } = await this.supabase
      .from('whatsapp_messages')
      .select('id, sender_jid, message_type, text_content, created_at, deleted_at')
      .eq('contact_id', contactId)
      .eq('deleted', true)
      .order('deleted_at', { ascending: false })
      .limit(limit);
    if (error) {
      throw new Error(`Failed to list deleted WhatsApp messages: ${error.message}`);
    }
    return (data ?? []).map((row) => {
      const r = row as {
        id: string;
        sender_jid: string;
        message_type: string;
        text_content: string | null;
        created_at: string;
        deleted_at: string | null;
      };
      return {
        id: r.id,
        senderJid: r.sender_jid,
        messageType: r.message_type,
        textContent: r.text_content ?? undefined,
        createdAt: r.created_at,
        deletedAt: r.deleted_at ?? undefined,
      };
    });
  }

  /** Same as purgeExpiredDeletedContent, scoped to a private contact instead of a group. */
  async purgeExpiredDeletedContentForContact(contactId: string, olderThan: Date): Promise<number> {
    const { data, error } = await this.supabase
      .from('whatsapp_messages')
      .update({ text_content: null })
      .eq('contact_id', contactId)
      .eq('deleted', true)
      .lte('deleted_at', olderThan.toISOString())
      .select('id');
    if (error) {
      throw new Error(`Failed to purge expired deleted-message content: ${error.message}`);
    }
    return Array.isArray(data) ? data.length : 0;
  }
}

export interface DeletedMessageRecord {
  id: string;
  senderJid: string;
  messageType: string;
  textContent: string | undefined;
  createdAt: string;
  deletedAt: string | undefined;
}
