import type { SupabaseClient } from '@supabase/supabase-js';

interface ModerationStateRow {
  rule_id: string;
  sender_jid: string;
  window_started_at: string;
  message_count: number;
}

/**
 * Durable per-(rule, sender) sliding window for the deterministic
 * "repeated messages" spam heuristic (`moderation` rules' `qualify`,
 * `spamRepeatThreshold`/`spamWindowSeconds`). Durable for the same reason
 * every other piece of rule-evaluation state in this project is
 * (`rule_matches`, `rule_cooldowns`) — a restart must not reset a
 * sender's in-progress spam count.
 */
export class ModerationStateRepository {
  constructor(private readonly supabase: SupabaseClient) {}

  /**
   * Records one message from this sender and returns the resulting count
   * within the window. If the existing window has expired, it resets to a
   * fresh window of 1.
   */
  async recordAndCount(ruleId: string, senderJid: string, windowSeconds: number): Promise<number> {
    const { data, error } = await this.supabase
      .from('whatsapp_moderation_state')
      .select('*')
      .eq('rule_id', ruleId)
      .eq('sender_jid', senderJid)
      .maybeSingle();
    if (error) {
      throw new Error(`Failed to load moderation state: ${error.message}`);
    }

    const now = new Date();
    const existing = data as ModerationStateRow | null;
    const windowExpired =
      !existing ||
      now.getTime() - new Date(existing.window_started_at).getTime() > windowSeconds * 1000;

    const nextCount = windowExpired ? 1 : existing.message_count + 1;
    const windowStartedAt = windowExpired ? now.toISOString() : existing.window_started_at;

    const { error: upsertError } = await this.supabase.from('whatsapp_moderation_state').upsert(
      {
        rule_id: ruleId,
        sender_jid: senderJid,
        window_started_at: windowStartedAt,
        message_count: nextCount,
      },
      { onConflict: 'rule_id,sender_jid' },
    );
    if (upsertError) {
      throw new Error(`Failed to update moderation state: ${upsertError.message}`);
    }

    return nextCount;
  }
}
