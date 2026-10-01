import {
  BufferJSON,
  initAuthCreds,
  type AuthenticationCreds,
  type SignalDataSet,
  type SignalDataTypeMap,
  type SignalKeyStore,
} from '@whiskeysockets/baileys';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Logger } from 'pino';
import { decryptJson, encryptJson, type EncryptedPayload } from '../../db/encryption';
import type { AuthLoadResult, AuthStateProvider } from './authStateProvider';
import { reviveSignalKeyValue } from './baileysSerialization';

interface EncryptedRow {
  ciphertext: string;
  iv: string;
  auth_tag: string;
}

// `updated_at` is set explicitly on every write (not by a database
// trigger — see the migration's header comment for why), so this return
// type is separate from `EncryptedRow`, which only describes what's read.
function toRow(payload: EncryptedPayload): EncryptedRow & { updated_at: string } {
  return {
    ciphertext: payload.ciphertext.toString('base64'),
    iv: payload.iv.toString('base64'),
    auth_tag: payload.authTag.toString('base64'),
    updated_at: new Date().toISOString(),
  };
}

function fromRow(row: EncryptedRow): EncryptedPayload {
  return {
    ciphertext: Buffer.from(row.ciphertext, 'base64'),
    iv: Buffer.from(row.iv, 'base64'),
    authTag: Buffer.from(row.auth_tag, 'base64'),
  };
}

export interface SupabaseAuthStateProviderOptions {
  accountId: string;
  supabase: SupabaseClient;
  encryptionKey: Buffer;
  logger: Logger;
}

/**
 * Durable, encrypted WhatsApp auth-state storage backed by Supabase —
 * see the migration under `supabase/migrations/` and docs/DECISIONS.md
 * ADR-011 for the schema, and docs/SECURITY.md for the encryption model.
 *
 * Implements the exact same `AuthStateProvider` interface as
 * `FileAuthStateProvider`; `WhatsAppConnectionManager` cannot tell which
 * one it's talking to.
 *
 * Critical safety property: a Supabase/network failure while loading
 * state must never be mistaken for "this account was never paired".
 * Every method here throws on a genuine query failure rather than
 * quietly falling back to a blank identity — the one and only path that
 * returns `initAuthCreds()` is a *successful* query that found no row.
 * See docs/SECURITY.md and docs/DECISIONS.md ADR-006/ADR-011.
 */
export class SupabaseAuthStateProvider implements AuthStateProvider {
  readonly kind = 'supabase';

  private readonly accountId: string;
  private readonly supabase: SupabaseClient;
  private readonly encryptionKey: Buffer;
  private readonly log: Logger;

  constructor(options: SupabaseAuthStateProviderOptions) {
    this.accountId = options.accountId;
    this.supabase = options.supabase;
    this.encryptionKey = options.encryptionKey;
    this.log = options.logger;
  }

  async init(): Promise<void> {
    // Nothing to provision — the table already exists (migration), scoped
    // by account_id. Connectivity problems surface naturally from load().
  }

  async load(): Promise<AuthLoadResult> {
    const { data, error } = await this.supabase
      .from('whatsapp_auth_credentials')
      .select('ciphertext, iv, auth_tag')
      .eq('account_id', this.accountId)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to load WhatsApp credentials from Supabase: ${error.message}`);
    }

    const creds: AuthenticationCreds = data
      ? decryptJson<AuthenticationCreds>(fromRow(data), this.encryptionKey, BufferJSON.reviver)
      : initAuthCreds();

    const saveCreds = async (): Promise<void> => {
      const payload = encryptJson(creds, this.encryptionKey, BufferJSON.replacer);
      const { error: upsertError } = await this.supabase
        .from('whatsapp_auth_credentials')
        .upsert({ account_id: this.accountId, ...toRow(payload) }, { onConflict: 'account_id' });
      if (upsertError) {
        this.log.error(
          { err: upsertError.message },
          'Failed to persist WhatsApp credentials to Supabase',
        );
        throw new Error(`Failed to persist WhatsApp credentials: ${upsertError.message}`);
      }
    };

    return { state: { creds, keys: this.buildKeyStore() }, saveCreds };
  }

  async hasExistingSession(): Promise<boolean> {
    const { data, error } = await this.supabase
      .from('whatsapp_auth_credentials')
      .select('ciphertext, iv, auth_tag')
      .eq('account_id', this.accountId)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to check WhatsApp session in Supabase: ${error.message}`);
    }
    if (!data) return false;

    const creds = decryptJson<AuthenticationCreds>(
      fromRow(data),
      this.encryptionKey,
      BufferJSON.reviver,
    );
    return Boolean(creds.registered);
  }

  async clear(): Promise<void> {
    this.log.warn({ accountId: this.accountId }, 'Clearing Supabase-backed WhatsApp auth state');

    const [credsResult, keysResult] = await Promise.all([
      this.supabase.from('whatsapp_auth_credentials').delete().eq('account_id', this.accountId),
      this.supabase.from('whatsapp_auth_keys').delete().eq('account_id', this.accountId),
    ]);

    if (credsResult.error) {
      throw new Error(`Failed to clear WhatsApp credentials: ${credsResult.error.message}`);
    }
    if (keysResult.error) {
      throw new Error(`Failed to clear WhatsApp auth keys: ${keysResult.error.message}`);
    }
  }

  private buildKeyStore(): SignalKeyStore {
    return {
      get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
        if (ids.length === 0) return {};

        const { data, error } = await this.supabase
          .from('whatsapp_auth_keys')
          .select('key_id, ciphertext, iv, auth_tag')
          .eq('account_id', this.accountId)
          .eq('category', type)
          .in('key_id', ids);

        if (error) {
          throw new Error(`Failed to read WhatsApp auth keys (${type}): ${error.message}`);
        }

        const result: { [id: string]: SignalDataTypeMap[T] } = {};
        for (const row of data ?? []) {
          const parsed = decryptJson<unknown>(fromRow(row), this.encryptionKey, BufferJSON.reviver);
          result[row.key_id] = reviveSignalKeyValue(type, parsed);
        }
        return result;
      },

      set: async (data: SignalDataSet) => {
        const upsertRows: Array<
          { account_id: string; category: string; key_id: string } & EncryptedRow & {
              updated_at: string;
            }
        > = [];
        const deletionsByCategory = new Map<string, string[]>();

        for (const category of Object.keys(data) as (keyof SignalDataTypeMap)[]) {
          const categoryData = data[category];
          if (!categoryData) continue;

          for (const [id, value] of Object.entries(categoryData)) {
            if (value === null || value === undefined) {
              const existing = deletionsByCategory.get(category) ?? [];
              existing.push(id);
              deletionsByCategory.set(category, existing);
            } else {
              const payload = encryptJson(value, this.encryptionKey, BufferJSON.replacer);
              upsertRows.push({
                account_id: this.accountId,
                category,
                key_id: id,
                ...toRow(payload),
              });
            }
          }
        }

        if (upsertRows.length > 0) {
          const { error } = await this.supabase
            .from('whatsapp_auth_keys')
            .upsert(upsertRows, { onConflict: 'account_id,category,key_id' });
          if (error) {
            this.log.error(
              { err: error.message },
              'Failed to persist WhatsApp auth keys to Supabase',
            );
            throw new Error(`Failed to persist WhatsApp auth keys: ${error.message}`);
          }
        }

        for (const [category, ids] of deletionsByCategory) {
          const { error } = await this.supabase
            .from('whatsapp_auth_keys')
            .delete()
            .eq('account_id', this.accountId)
            .eq('category', category)
            .in('key_id', ids);
          if (error) {
            throw new Error(`Failed to delete WhatsApp auth keys (${category}): ${error.message}`);
          }
        }
      },

      clear: async () => {
        const { error } = await this.supabase
          .from('whatsapp_auth_keys')
          .delete()
          .eq('account_id', this.accountId);
        if (error) {
          throw new Error(`Failed to clear WhatsApp auth keys: ${error.message}`);
        }
      },
    };
  }
}
