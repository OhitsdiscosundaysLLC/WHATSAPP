import { describe, expect, it } from 'vitest';
import type { DatabaseHealth } from '../db/supabaseClient';
import type { WhatsAppStatus } from '../whatsapp/types';
import type { AuthPersistenceStatus } from './healthService';
import { getHealthReport, getReadiness } from './healthService';

function status(overrides: Partial<WhatsAppStatus> = {}): WhatsAppStatus {
  return {
    state: 'disabled',
    reconnectAttempt: 0,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

const notConfiguredDb: DatabaseHealth = { status: 'not_configured', detail: 'not set' };
const okDb: DatabaseHealth = { status: 'ok' };
const unavailableDb: DatabaseHealth = { status: 'unavailable', detail: 'query failed' };

const fileAuth: AuthPersistenceStatus = { mode: 'file', durable: false };
const supabaseAuth: AuthPersistenceStatus = { mode: 'supabase', durable: true };

function report(
  whatsapp: WhatsAppStatus,
  database: DatabaseHealth = notConfiguredDb,
  authPersistence: AuthPersistenceStatus = fileAuth,
) {
  return getHealthReport({ whatsapp, database, authPersistence });
}

describe('getHealthReport', () => {
  it('reflects the WhatsApp state it was given', () => {
    const r = report(status({ state: 'connected', lastConnectedAt: '2026-01-01T00:00:00.000Z' }));
    expect(r.components.whatsapp.status).toBe('connected');
    expect(r.components.whatsapp.lastConnectedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('never reports whatsapp status as a placeholder — always the real state', () => {
    const r = report(status({ state: 'awaiting_qr' }));
    expect(r.components.whatsapp.status).toBe('awaiting_qr');
  });

  it('keeps top-level status "ok" (liveness) even while WhatsApp is reconnecting', () => {
    const r = report(status({ state: 'reconnecting' }));
    expect(r.status).toBe('ok');
  });

  it('reflects the real database health it was given, not a hardcoded placeholder', () => {
    expect(report(status(), notConfiguredDb).components.database.status).toBe('not_configured');
    expect(report(status(), okDb).components.database.status).toBe('ok');
    expect(report(status(), unavailableDb).components.database.status).toBe('unavailable');
  });

  it('surfaces authPersistence (durable vs ephemeral) under the whatsapp component', () => {
    expect(report(status(), okDb, fileAuth).components.whatsapp.authPersistence).toEqual(fileAuth);
    expect(report(status(), okDb, supabaseAuth).components.whatsapp.authPersistence).toEqual(
      supabaseAuth,
    );
  });

  it('never includes qr, pairingCode, or any credential/key material', () => {
    const r = report(status({ state: 'awaiting_qr' }), okDb, supabaseAuth);
    const text = JSON.stringify(r);
    expect(text).not.toMatch(/"qr"/i);
    expect(text).not.toMatch(/pairingCode/i);
    expect(text).not.toMatch(/ciphertext/i);
    expect(text).not.toMatch(/encryptionKey/i);
  });
});

describe('getReadiness', () => {
  it('is ready when WhatsApp is connected', () => {
    expect(getReadiness(status({ state: 'connected' })).ready).toBe(true);
  });

  it('is not ready while awaiting QR or reconnecting', () => {
    expect(getReadiness(status({ state: 'awaiting_qr' })).ready).toBe(false);
    expect(getReadiness(status({ state: 'reconnecting' })).ready).toBe(false);
  });
});
