import { promises as fs } from 'fs';
import path from 'path';
import { useMultiFileAuthState } from '@whiskeysockets/baileys';
import type { Logger } from 'pino';
import { createChildLogger } from '../../services/logger';
import type { AuthLoadResult, AuthStateProvider } from './authStateProvider';

/**
 * Local-filesystem auth state storage, backed by Baileys' own
 * `useMultiFileAuthState`. Development-only: Render's filesystem is
 * ephemeral across deploys/restarts, so this does not satisfy the
 * production durability requirement — see docs/DECISIONS.md ADR-006 for
 * what a production-grade provider implementing this same interface must
 * do instead.
 *
 * Never logs file contents. Only ever logs the directory path and booleans.
 */
export class FileAuthStateProvider implements AuthStateProvider {
  readonly kind = 'file';

  private readonly dir: string;
  private readonly log: Logger;

  constructor(dir: string) {
    this.dir = dir;
    this.log = createChildLogger('whatsapp:auth:file');
  }

  async init(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    try {
      // Belt-and-suspenders: mkdir's `mode` can be affected by umask, so set
      // restrictive permissions explicitly. Best-effort — not all
      // filesystems/platforms honor this, hence the try/catch.
      await fs.chmod(this.dir, 0o700);
    } catch (err) {
      this.log.warn(
        { err, dir: this.dir },
        'Could not set restrictive permissions on auth directory',
      );
    }
  }

  async load(): Promise<AuthLoadResult> {
    const { state, saveCreds } = await useMultiFileAuthState(this.dir);
    return {
      state,
      saveCreds: async () => {
        try {
          await saveCreds();
        } catch (err) {
          this.log.error({ err }, 'Failed to persist WhatsApp credential update');
          throw err;
        }
      },
    };
  }

  async hasExistingSession(): Promise<boolean> {
    try {
      const raw = await fs.readFile(path.join(this.dir, 'creds.json'), 'utf8');
      const parsed = JSON.parse(raw) as { registered?: boolean };
      return Boolean(parsed.registered);
    } catch {
      return false;
    }
  }

  async clear(): Promise<void> {
    this.log.warn({ dir: this.dir }, 'Clearing local WhatsApp auth state');
    await fs.rm(this.dir, { recursive: true, force: true });
  }
}
