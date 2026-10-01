import { DisconnectReason } from '@whiskeysockets/baileys';

export type ReconnectAction = 'reconnect' | 'reconnect_immediate' | 'logout' | 'stop';

/**
 * Baileys surfaces the close reason as a Boom error with
 * `error.output.statusCode`. This reads it defensively, since the value can
 * also be a plain Error or undefined (e.g. a raw network drop).
 */
export function extractStatusCode(error: unknown): number | undefined {
  if (error && typeof error === 'object' && 'output' in error) {
    const output = (error as { output?: unknown }).output;
    if (output && typeof output === 'object' && 'statusCode' in output) {
      const statusCode = (output as { statusCode?: unknown }).statusCode;
      if (typeof statusCode === 'number') {
        return statusCode;
      }
    }
  }
  return undefined;
}

/**
 * Decides what to do after a WhatsApp connection closes, given the
 * DisconnectReason status code. Pure function — no socket, no I/O — so it's
 * directly unit-testable. Does not know about an "explicit logout we
 * initiated" — the caller (connectionManager) short-circuits that case
 * before consulting this function, since it's not something Baileys reports
 * via statusCode.
 *
 * Reference: @whiskeysockets/baileys 6.7.24 `DisconnectReason` enum.
 * `connectionLost` and `timedOut` share the same numeric value (408).
 */
export function decideOnDisconnect(statusCode: number | undefined): ReconnectAction {
  switch (statusCode) {
    case DisconnectReason.loggedOut:
      // WhatsApp reported the device was unlinked. Credentials are dead.
      return 'logout';
    case DisconnectReason.restartRequired:
      // Baileys explicitly asks for an immediate fresh socket (e.g. right
      // after initial pairing) — not a failure, no backoff needed.
      return 'reconnect_immediate';
    case DisconnectReason.connectionClosed:
    case DisconnectReason.connectionLost: // === DisconnectReason.timedOut (408)
    case DisconnectReason.unavailableService:
      return 'reconnect';
    case DisconnectReason.connectionReplaced:
    case DisconnectReason.multideviceMismatch:
    case DisconnectReason.forbidden:
    case DisconnectReason.badSession:
      // Reconnecting automatically would either fight another active
      // session (connectionReplaced) or retry a request that will keep
      // failing the same way (bad session data, version mismatch, a
      // forbidden/banned account). Stop and surface it instead of looping.
      return 'stop';
    default:
      // Unknown or missing status code (e.g. a raw network-level drop with
      // no Boom payload) — treat as transient and retry.
      return 'reconnect';
  }
}

export interface BackoffConfig {
  baseMs: number;
  maxMs: number;
}

/**
 * Capped exponential backoff with "equal jitter" (half fixed, half random),
 * so delays grow predictably but avoid every reconnect attempt landing on
 * the exact same schedule. `random` is injectable for deterministic tests.
 */
export function computeBackoffDelayMs(
  attempt: number,
  { baseMs, maxMs }: BackoffConfig,
  random: () => number = Math.random,
): number {
  const safeAttempt = Math.max(1, attempt);
  const exponential = Math.min(maxMs, baseMs * 2 ** (safeAttempt - 1));
  const jitter = exponential * 0.5 * random();
  return Math.round(Math.min(maxMs, exponential * 0.5 + jitter));
}
