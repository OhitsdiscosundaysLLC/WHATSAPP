import type { AuthenticationState } from '@whiskeysockets/baileys';

export interface AuthLoadResult {
  state: AuthenticationState;
  /** Persist credential updates. Must be called on every `creds.update` event. */
  saveCreds: () => Promise<void>;
}

/**
 * Abstraction over where/how WhatsApp multi-device auth state (credentials +
 * signal keys) is stored. The WhatsApp client/connection manager depends
 * only on this interface, never on a concrete storage mechanism, so storage
 * can change (e.g. local files in development → a durable Supabase-backed
 * store in production, see docs/DECISIONS.md ADR-006) without touching
 * connection logic.
 */
export interface AuthStateProvider {
  /** Short label for logging/health reporting, e.g. "file". */
  readonly kind: string;

  /** Prepare storage (e.g. create a directory). Safe to call every startup. */
  init(): Promise<void>;

  /** Load the current auth state, creating a blank one if none exists yet. */
  load(): Promise<AuthLoadResult>;

  /**
   * Whether a previously-authenticated session appears to exist, without
   * necessarily loading the full signal key store. Used for startup logging
   * ("reconnecting with existing session" vs "no session, QR required").
   */
  hasExistingSession(): Promise<boolean>;

  /**
   * Permanently erase stored auth state. Only called on an explicit,
   * controlled logout (owner-initiated, or WhatsApp reporting the device was
   * unlinked) — never automatically on a transient disconnect.
   */
  clear(): Promise<void>;
}
