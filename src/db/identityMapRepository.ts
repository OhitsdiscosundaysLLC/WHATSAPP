import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Durable `@lid` <-> `<number>@s.whatsapp.net` mapping, per account — see
 * src/whatsapp/identity/identityResolver.ts for why this exists and how
 * it's populated. Never guessed at: every row comes from a Baileys-
 * provided pairing (a message's `participantPn`/`participantLid`, or a
 * discovered group participant's `Contact.lid`/`Contact.jid`).
 */
export class IdentityMapRepository {
  constructor(private readonly supabase: SupabaseClient) {}

  async upsert(accountId: string, lidJid: string, phoneJid: string): Promise<void> {
    const { error } = await this.supabase.from('whatsapp_identity_map').upsert(
      {
        account_id: accountId,
        lid_jid: lidJid,
        phone_jid: phoneJid,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'account_id,lid_jid' },
    );
    if (error) {
      throw new Error(`Failed to record WhatsApp identity mapping: ${error.message}`);
    }
  }

  async getPhoneJidForLid(accountId: string, lidJid: string): Promise<string | undefined> {
    const { data, error } = await this.supabase
      .from('whatsapp_identity_map')
      .select('phone_jid')
      .eq('account_id', accountId)
      .eq('lid_jid', lidJid)
      .maybeSingle();
    if (error) {
      throw new Error(`Failed to look up WhatsApp identity mapping: ${error.message}`);
    }
    const row = data as { phone_jid: string } | null;
    return row?.phone_jid;
  }
}
