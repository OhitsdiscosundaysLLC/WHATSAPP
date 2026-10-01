import { config } from '../config/config';
import { parseEncryptionKey } from '../db/encryption';

export type AuthStorageMode = { kind: 'file' } | { kind: 'supabase'; encryptionKey: Buffer };

/**
 * Decides whether WhatsApp accounts/auth-state should be stored durably in
 * Supabase or ephemerally on the local filesystem — see docs/DECISIONS.md
 * ADR-011.
 *
 * Deliberately strict: if Supabase is configured (URL + service role key)
 * but `WHATSAPP_AUTH_ENCRYPTION_KEY` is missing or malformed, this throws
 * rather than silently falling back to file storage. Quietly running
 * ephemeral, unencrypted-at-rest auth storage while the owner believes
 * Supabase persistence is active would be exactly the "insecure partial
 * deployment" this project's own rules forbid — see docs/SECURITY.md.
 *
 * Callers must not call this at module load time (it would crash the
 * whole process, including the HTTP server, on a config mistake) — call
 * it lazily and handle the throw by surfacing a clear, non-fatal error
 * through `/health` and account-creation responses instead. See
 * `AccountManager.load()`.
 */
export function resolveAuthStorageMode(): AuthStorageMode {
  if (!config.supabase.configured) {
    return { kind: 'file' };
  }
  const encryptionKey = parseEncryptionKey(config.whatsapp.authEncryptionKey);
  return { kind: 'supabase', encryptionKey };
}
