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

  /** Stores a normalized message — only call this when the group's monitoring is enabled. */
  async store(event: NormalizedMessageEvent, groupId: string | undefined): Promise<void> {
    const { error } = await this.supabase.from('whatsapp_messages').insert({
      account_id: event.accountId,
      group_id: groupId ?? null,
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
}
