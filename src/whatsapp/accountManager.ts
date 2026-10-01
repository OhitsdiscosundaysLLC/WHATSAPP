import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { config } from '../config/config';
import { createChildLogger } from '../services/logger';
import { FileAuthStateProvider } from './auth/fileAuthStateProvider';
import { WhatsAppConnectionManager } from './connectionManager';
import type { PairingListener, PairingSnapshot, WhatsAppStatus } from './types';

const log = createChildLogger('whatsapp:accounts');

export interface AccountSummary {
  id: string;
  label: string;
  createdAt: string;
  status: WhatsAppStatus;
}

interface AccountRecord {
  id: string;
  label: string;
  createdAt: string;
  manager: WhatsAppConnectionManager;
}

interface ManifestEntry {
  id: string;
  label: string;
  createdAt: string;
}

const MAX_LABEL_LENGTH = 60;

/**
 * Multi-account registry: one `WhatsAppConnectionManager` (and its own,
 * per-account `FileAuthStateProvider` rooted at
 * `${WHATSAPP_AUTH_DIR}/<accountId>/`) per WhatsApp account. See
 * docs/ARCHITECTURE.md for why Phase 2 (single implicit account) was
 * refactored into this registry rather than bolting multi-account support
 * on later.
 *
 * The account *list itself* (id/label/createdAt) is persisted as a small
 * JSON manifest — not a database, and not the same thing as durable
 * WhatsApp session storage (which remains the unsolved Phase 3 problem;
 * see docs/DECISIONS.md ADR-006). This manifest only survives for as long
 * as the local filesystem does, same as everything else under
 * WHATSAPP_AUTH_DIR.
 */
export class AccountManager {
  private readonly authRootDir: string;
  private readonly manifestPath: string;
  private readonly accounts = new Map<string, AccountRecord>();
  private loaded = false;

  constructor(authRootDir: string) {
    this.authRootDir = authRootDir;
    this.manifestPath = path.join(authRootDir, 'accounts.json');
  }

  /** Loads the manifest and constructs (but does not start) each account's manager. */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;

    await fs.mkdir(this.authRootDir, { recursive: true, mode: 0o700 });

    let entries: ManifestEntry[] = [];
    try {
      const raw = await fs.readFile(this.manifestPath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        entries = parsed.filter(isManifestEntry);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn({ err }, 'Could not read WhatsApp accounts manifest; starting with no accounts');
      }
    }

    for (const entry of entries) {
      this.accounts.set(entry.id, {
        id: entry.id,
        label: entry.label,
        createdAt: entry.createdAt,
        manager: this.buildManager(entry.id),
      });
    }

    log.info({ accountCount: this.accounts.size }, 'Loaded WhatsApp account registry');
  }

  /** Starts (or resumes) every known account's connection. Call once at boot. */
  async startAll(): Promise<void> {
    await this.load();
    await Promise.allSettled(
      [...this.accounts.values()].map((account) =>
        account.manager
          .start()
          .catch((err: unknown) =>
            log.error({ err, accountId: account.id }, 'Failed to start account'),
          ),
      ),
    );
  }

  async shutdownAll(): Promise<void> {
    await Promise.allSettled(
      [...this.accounts.values()].map((account) => account.manager.shutdown()),
    );
  }

  listAccounts(): AccountSummary[] {
    return [...this.accounts.values()]
      .map((account) => ({
        id: account.id,
        label: account.label,
        createdAt: account.createdAt,
        status: account.manager.getStatus(),
      }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async createAccount(rawLabel: string): Promise<AccountSummary> {
    await this.load();

    const label = normalizeLabel(rawLabel, this.accounts.size + 1);
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const manager = this.buildManager(id);

    this.accounts.set(id, { id, label, createdAt, manager });
    await this.persistManifest();

    log.info({ accountId: id, label }, 'Created WhatsApp account');
    this.maybeStart(manager, id);

    return { id, label, createdAt, status: manager.getStatus() };
  }

  /** Re-attempts connection for an account that is e.g. logged_out or errored. */
  async reconnectAccount(id: string): Promise<AccountSummary | undefined> {
    const account = this.accounts.get(id);
    if (!account) return undefined;
    if (!config.whatsapp.enabled) {
      log.warn({ accountId: id }, 'Ignoring reconnect request: WHATSAPP_ENABLED=false');
      return {
        id: account.id,
        label: account.label,
        createdAt: account.createdAt,
        status: account.manager.getStatus(),
      };
    }
    await account.manager.start();
    return {
      id: account.id,
      label: account.label,
      createdAt: account.createdAt,
      status: account.manager.getStatus(),
    };
  }

  /** Starts an account's connection unless WhatsApp integration is globally disabled. */
  private maybeStart(manager: WhatsAppConnectionManager, accountId: string): void {
    if (!config.whatsapp.enabled) {
      log.warn({ accountId }, 'Not starting account: WHATSAPP_ENABLED=false');
      return;
    }
    void manager
      .start()
      .catch((err: unknown) => log.error({ err, accountId }, 'Failed to start account'));
  }

  /** Unlinks the device and clears credentials, but keeps the account slot for re-pairing. */
  async disconnectAccount(id: string): Promise<AccountSummary | undefined> {
    const account = this.accounts.get(id);
    if (!account) return undefined;
    await account.manager.requestLogout();
    return {
      id: account.id,
      label: account.label,
      createdAt: account.createdAt,
      status: account.manager.getStatus(),
    };
  }

  /** Fully removes the account: unlinks, clears all local state, deletes the slot. */
  async removeAccount(id: string): Promise<boolean> {
    const account = this.accounts.get(id);
    if (!account) return false;

    await account.manager.requestLogout();
    await account.manager.shutdown();
    this.accounts.delete(id);
    await this.persistManifest();

    log.info({ accountId: id }, 'Removed WhatsApp account');
    return true;
  }

  async requestPairingCode(id: string, phoneNumber: string): Promise<string | undefined> {
    const account = this.accounts.get(id);
    if (!account) return undefined;
    return account.manager.requestPairingCode(phoneNumber);
  }

  getPairingSnapshot(id: string): PairingSnapshot | undefined {
    return this.accounts.get(id)?.manager.getPairingSnapshot();
  }

  onAccountUpdate(id: string, listener: PairingListener): (() => void) | undefined {
    return this.accounts.get(id)?.manager.onUpdate(listener);
  }

  hasAccount(id: string): boolean {
    return this.accounts.has(id);
  }

  /**
   * A single representative status for `/health` and `/ready`, which were
   * designed around one WhatsApp connection (Phase 2) and intentionally
   * were not redesigned around a list in Phase 2B — see docs/ARCHITECTURE.md.
   * Prefers a connected account; falls back to the first known account;
   * reports `disabled` if there are none yet.
   */
  getAggregateStatus(): WhatsAppStatus {
    const all = [...this.accounts.values()];
    if (all.length === 0) {
      return {
        state: 'disabled',
        detail: 'No WhatsApp accounts configured yet — add one from the dashboard.',
        reconnectAttempt: 0,
        updatedAt: new Date().toISOString(),
      };
    }

    const connected = all.find((a) => a.manager.getStatus().state === 'connected');
    return (connected ?? all[0]!).manager.getStatus();
  }

  private buildManager(accountId: string): WhatsAppConnectionManager {
    const authProvider = new FileAuthStateProvider(path.join(this.authRootDir, accountId));
    return new WhatsAppConnectionManager({
      authProvider,
      logger: createChildLogger(`whatsapp:account:${accountId}`),
      reconnect: {
        baseMs: config.whatsapp.reconnectBaseMs,
        maxMs: config.whatsapp.reconnectMaxMs,
      },
    });
  }

  private async persistManifest(): Promise<void> {
    const entries: ManifestEntry[] = [...this.accounts.values()].map((a) => ({
      id: a.id,
      label: a.label,
      createdAt: a.createdAt,
    }));
    const tmpPath = `${this.manifestPath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(entries, null, 2), 'utf8');
    await fs.rename(tmpPath, this.manifestPath);
  }
}

function normalizeLabel(rawLabel: string, fallbackIndex: number): string {
  const trimmed = rawLabel.trim().slice(0, MAX_LABEL_LENGTH);
  return trimmed.length > 0 ? trimmed : `WhatsApp Account ${fallbackIndex}`;
}

function isManifestEntry(value: unknown): value is ManifestEntry {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' && typeof v.label === 'string' && typeof v.createdAt === 'string';
}

export const accountManager = new AccountManager(config.whatsapp.authDir);
