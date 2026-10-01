import { promises as fs } from 'fs';
import path from 'path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createChildLogger } from '../services/logger';

export interface StoredAccount {
  id: string;
  label: string;
  createdAt: string;
  lastConnectedAt?: string | undefined;
}

/**
 * Durable storage for the WhatsApp account *list* (id/label/timestamps) —
 * deliberately separate from `AuthStateProvider`, which stores the much
 * more sensitive credentials/key material for one account. Two
 * implementations, selected by `src/whatsapp/authStorageMode.ts`:
 * `JsonManifestAccountStore` (local dev) and `SupabaseAccountStore`
 * (production — see docs/DECISIONS.md ADR-011).
 */
export interface AccountStore {
  readonly kind: string;
  list(): Promise<StoredAccount[]>;
  create(account: StoredAccount): Promise<void>;
  remove(id: string): Promise<void>;
  /** Best-effort: a failed write here must never affect the WhatsApp connection itself. */
  touchLastConnected(id: string): Promise<void>;
}

const log = createChildLogger('whatsapp:accountStore');

/**
 * Local-filesystem account list, backed by a single JSON manifest file.
 * Development-only — see docs/DECISIONS.md ADR-006/ADR-011 for why this
 * isn't durable enough for Render production.
 */
export class JsonManifestAccountStore implements AccountStore {
  readonly kind = 'file';

  private readonly manifestPath: string;
  private readonly entries = new Map<string, StoredAccount>();
  private loaded = false;

  constructor(authRootDir: string) {
    this.manifestPath = path.join(authRootDir, 'accounts.json');
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;

    await fs.mkdir(path.dirname(this.manifestPath), { recursive: true, mode: 0o700 });

    try {
      const raw = await fs.readFile(this.manifestPath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (isStoredAccount(entry)) {
            this.entries.set(entry.id, entry);
          }
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn({ err }, 'Could not read WhatsApp accounts manifest; starting with no accounts');
      }
    }
  }

  async list(): Promise<StoredAccount[]> {
    await this.ensureLoaded();
    return [...this.entries.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async create(account: StoredAccount): Promise<void> {
    await this.ensureLoaded();
    this.entries.set(account.id, account);
    await this.persist();
  }

  async remove(id: string): Promise<void> {
    await this.ensureLoaded();
    this.entries.delete(id);
    await this.persist();
  }

  async touchLastConnected(id: string): Promise<void> {
    await this.ensureLoaded();
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.lastConnectedAt = new Date().toISOString();
    await this.persist();
  }

  private async persist(): Promise<void> {
    const tmpPath = `${this.manifestPath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify([...this.entries.values()], null, 2), 'utf8');
    await fs.rename(tmpPath, this.manifestPath);
  }
}

function isStoredAccount(value: unknown): value is StoredAccount {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' && typeof v.label === 'string' && typeof v.createdAt === 'string';
}

interface AccountRow {
  id: string;
  label: string;
  created_at: string;
  last_connected_at: string | null;
}

/** Durable account list backed by the `whatsapp_accounts` Supabase table. */
export class SupabaseAccountStore implements AccountStore {
  readonly kind = 'supabase';

  constructor(private readonly supabase: SupabaseClient) {}

  async list(): Promise<StoredAccount[]> {
    const { data, error } = await this.supabase
      .from('whatsapp_accounts')
      .select('id, label, created_at, last_connected_at')
      .order('created_at', { ascending: true });

    if (error) {
      throw new Error(`Failed to list WhatsApp accounts from Supabase: ${error.message}`);
    }
    return (data ?? []).map(fromRow);
  }

  async create(account: StoredAccount): Promise<void> {
    const { error } = await this.supabase.from('whatsapp_accounts').insert({
      id: account.id,
      label: account.label,
      created_at: account.createdAt,
    });
    if (error) {
      throw new Error(`Failed to create WhatsApp account in Supabase: ${error.message}`);
    }
  }

  async remove(id: string): Promise<void> {
    const { error } = await this.supabase.from('whatsapp_accounts').delete().eq('id', id);
    if (error) {
      throw new Error(`Failed to remove WhatsApp account from Supabase: ${error.message}`);
    }
  }

  async touchLastConnected(id: string): Promise<void> {
    const now = new Date().toISOString();
    const { error } = await this.supabase
      .from('whatsapp_accounts')
      .update({ last_connected_at: now, updated_at: now })
      .eq('id', id);
    if (error) {
      // Deliberately not thrown — see the interface doc comment. A failed
      // "last connected" timestamp update must never affect the live
      // WhatsApp connection it's merely annotating.
      log.warn(
        { err: error.message, accountId: id },
        'Failed to update last_connected_at in Supabase',
      );
    }
  }
}

function fromRow(row: AccountRow): StoredAccount {
  return {
    id: row.id,
    label: row.label,
    createdAt: row.created_at,
    lastConnectedAt: row.last_connected_at ?? undefined,
  };
}
