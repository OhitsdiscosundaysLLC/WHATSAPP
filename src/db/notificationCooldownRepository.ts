import type { SupabaseClient } from '@supabase/supabase-js';

const DEFAULT_COOLDOWN_SECONDS = 30;

/**
 * Cooldown/dedup for owner notifications triggered outside the rule
 * engine's own per-rule cooldown mechanism — a deleted message detected,
 * a call attempted. "Must have cooldown/dedup protection, do not spam the
 * owner" (product spec Part H). Durable in Supabase, same reasoning as
 * every other piece of rule/cooldown state in this project.
 */
export class NotificationCooldownRepository {
  constructor(private readonly supabase: SupabaseClient) {}

  /**
   * Returns `true` and records the attempt if a notification for this key
   * is currently allowed (no prior send within the cooldown window);
   * returns `false` without recording anything if still within cooldown.
   */
  async tryNotify(
    accountId: string,
    notificationKey: string,
    cooldownSeconds = DEFAULT_COOLDOWN_SECONDS,
  ): Promise<boolean> {
    const { data, error } = await this.supabase
      .from('whatsapp_notification_cooldowns')
      .select('last_sent_at')
      .eq('account_id', accountId)
      .eq('notification_key', notificationKey)
      .maybeSingle();
    if (error) {
      throw new Error(`Failed to load notification cooldown: ${error.message}`);
    }

    const row = data as { last_sent_at: string } | null;
    if (row) {
      const elapsedSeconds = (Date.now() - new Date(row.last_sent_at).getTime()) / 1000;
      if (elapsedSeconds < cooldownSeconds) return false;
    }

    const { error: upsertError } = await this.supabase
      .from('whatsapp_notification_cooldowns')
      .upsert(
        {
          account_id: accountId,
          notification_key: notificationKey,
          last_sent_at: new Date().toISOString(),
        },
        { onConflict: 'account_id,notification_key' },
      );
    if (upsertError) {
      throw new Error(`Failed to record notification cooldown: ${upsertError.message}`);
    }
    return true;
  }
}
