import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface WhatsAppAdmin {
  id: string;
  accountId: string;
  phoneNumber: string;
  label: string | undefined;
  createdAt: string;
}

interface AdminRow {
  id: string;
  account_id: string;
  phone_number: string;
  label: string | null;
  created_at: string;
}

function fromRow(row: AdminRow): WhatsAppAdmin {
  return {
    id: row.id,
    accountId: row.account_id,
    phoneNumber: row.phone_number,
    label: row.label ?? undefined,
    createdAt: row.created_at,
  };
}

/**
 * Dashboard-managed admins — augments (never replaces) the env-configured
 * `ADMIN_WHATSAPP_NUMBERS`. The owner stays exclusively env-configured
 * (`OWNER_WHATSAPP_NUMBERS`): nothing in this repository can ever grant
 * owner-level authority, which is what prevents an admin from promoting
 * themselves (or anyone else) to owner through the dashboard or a command.
 * See docs/SECURITY.md.
 */
export class AdminsRepository {
  constructor(private readonly supabase: SupabaseClient) {}

  async listByAccount(accountId: string): Promise<WhatsAppAdmin[]> {
    const { data, error } = await this.supabase
      .from('whatsapp_admins')
      .select('*')
      .eq('account_id', accountId)
      .order('created_at', { ascending: true });
    if (error) {
      throw new Error(`Failed to list admins: ${error.message}`);
    }
    return (data ?? []).map((row) => fromRow(row as AdminRow));
  }

  async listAll(): Promise<WhatsAppAdmin[]> {
    const { data, error } = await this.supabase
      .from('whatsapp_admins')
      .select('*')
      .order('created_at', { ascending: true });
    if (error) {
      throw new Error(`Failed to list admins: ${error.message}`);
    }
    return (data ?? []).map((row) => fromRow(row as AdminRow));
  }

  /** Digits-only phone number, same format as ADMIN_WHATSAPP_NUMBERS entries. */
  async add(
    accountId: string,
    phoneNumber: string,
    label: string | undefined,
  ): Promise<WhatsAppAdmin> {
    const { data, error } = await this.supabase
      .from('whatsapp_admins')
      .insert({
        id: randomUUID(),
        account_id: accountId,
        phone_number: phoneNumber,
        label: label || null,
        added_by: 'owner',
        created_at: new Date().toISOString(),
      })
      .select('*')
      .maybeSingle();
    if (error || !data) {
      throw new Error(`Failed to add admin: ${error?.message ?? 'no row returned'}`);
    }
    return fromRow(data as AdminRow);
  }

  async remove(id: string): Promise<void> {
    const { error } = await this.supabase.from('whatsapp_admins').delete().eq('id', id);
    if (error) {
      throw new Error(`Failed to remove admin: ${error.message}`);
    }
  }
}
