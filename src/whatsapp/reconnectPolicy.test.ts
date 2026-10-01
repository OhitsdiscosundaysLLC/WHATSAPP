import { DisconnectReason } from '@whiskeysockets/baileys';
import { describe, expect, it } from 'vitest';
import { computeBackoffDelayMs, decideOnDisconnect, extractStatusCode } from './reconnectPolicy';

describe('decideOnDisconnect', () => {
  it('returns "logout" when WhatsApp reports the device was unlinked', () => {
    expect(decideOnDisconnect(DisconnectReason.loggedOut)).toBe('logout');
  });

  it('returns "reconnect_immediate" when Baileys asks for a restart', () => {
    expect(decideOnDisconnect(DisconnectReason.restartRequired)).toBe('reconnect_immediate');
  });

  it.each([
    DisconnectReason.connectionClosed,
    DisconnectReason.connectionLost,
    DisconnectReason.unavailableService,
  ])('returns "reconnect" for transient code %i', (code) => {
    expect(decideOnDisconnect(code)).toBe('reconnect');
  });

  it.each([
    DisconnectReason.connectionReplaced,
    DisconnectReason.multideviceMismatch,
    DisconnectReason.forbidden,
    DisconnectReason.badSession,
  ])('returns "stop" for unrecoverable code %i', (code) => {
    expect(decideOnDisconnect(code)).toBe('stop');
  });

  it('treats an unknown/missing status code as transient', () => {
    expect(decideOnDisconnect(undefined)).toBe('reconnect');
    expect(decideOnDisconnect(999_999)).toBe('reconnect');
  });
});

describe('extractStatusCode', () => {
  it('reads a Boom-shaped error', () => {
    expect(extractStatusCode({ output: { statusCode: 401 } })).toBe(401);
  });

  it('returns undefined for a plain Error', () => {
    expect(extractStatusCode(new Error('network drop'))).toBeUndefined();
  });

  it('returns undefined for undefined/null/non-object input', () => {
    expect(extractStatusCode(undefined)).toBeUndefined();
    expect(extractStatusCode(null)).toBeUndefined();
    expect(extractStatusCode('close')).toBeUndefined();
  });
});

describe('computeBackoffDelayMs', () => {
  const config = { baseMs: 1000, maxMs: 30_000 };

  it('grows with attempt number (holding jitter constant)', () => {
    const noJitter = () => 0;
    const d1 = computeBackoffDelayMs(1, config, noJitter);
    const d2 = computeBackoffDelayMs(2, config, noJitter);
    const d3 = computeBackoffDelayMs(3, config, noJitter);
    expect(d1).toBeLessThan(d2);
    expect(d2).toBeLessThan(d3);
  });

  it('never exceeds maxMs even for very high attempt counts', () => {
    const maxJitter = () => 1;
    const delay = computeBackoffDelayMs(50, config, maxJitter);
    expect(delay).toBeLessThanOrEqual(config.maxMs);
  });

  it('never goes below zero and treats attempt < 1 as attempt 1', () => {
    const noJitter = () => 0;
    const delay = computeBackoffDelayMs(0, config, noJitter);
    expect(delay).toBe(computeBackoffDelayMs(1, config, noJitter));
    expect(delay).toBeGreaterThanOrEqual(0);
  });

  it('includes jitter so two calls at the same attempt can differ', () => {
    let call = 0;
    const alternating = () => (call++ % 2 === 0 ? 0 : 1);
    const a = computeBackoffDelayMs(3, config, alternating);
    const b = computeBackoffDelayMs(3, config, alternating);
    expect(a).not.toBe(b);
  });
});
