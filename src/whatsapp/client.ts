import {
  Browsers,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  makeWASocket,
  type AuthenticationState,
  type WASocket,
} from '@whiskeysockets/baileys';
import type { Logger } from 'pino';

export interface CreateSocketParams {
  authState: AuthenticationState;
  logger: Logger;
}

/**
 * Thin factory around Baileys' `makeWASocket`. Deliberately minimal for
 * Phase 2: no message-sending config, no history sync — this module's only
 * job is producing a connected-capable socket wired to the given auth
 * state. Event subscription and lifecycle live in `connectionManager.ts`.
 */
/**
 * Networks this runs on (containers, restricted egress, flaky proxies) can
 * leave an un-timed-out HTTP call hanging indefinitely rather than failing
 * fast. `fetchLatestBaileysVersion` is a non-essential nicety (Baileys has
 * a perfectly good built-in default version), so it must never be allowed
 * to stall the whole connection attempt.
 */
const VERSION_FETCH_TIMEOUT_MS = 10_000;

export async function createWhatsAppSocket({
  authState,
  logger,
}: CreateSocketParams): Promise<WASocket> {
  let version: [number, number, number] | undefined;
  try {
    const versionInfo = await fetchLatestBaileysVersion({ timeout: VERSION_FETCH_TIMEOUT_MS });
    version = versionInfo.version;
    if (!versionInfo.isLatest) {
      logger.info(
        { version: versionInfo.version },
        'Using a newer known WhatsApp Web protocol version than Baileys ships as default',
      );
    }
  } catch (err) {
    logger.warn(
      { err },
      'Could not fetch latest WhatsApp Web protocol version; using library default',
    );
  }

  return makeWASocket({
    auth: {
      creds: authState.creds,
      keys: makeCacheableSignalKeyStore(authState.keys, logger),
    },
    logger,
    browser: Browsers.ubuntu('Chrome'),
    syncFullHistory: false,
    markOnlineOnConnect: false,
    ...(version ? { version } : {}),
  });
}
