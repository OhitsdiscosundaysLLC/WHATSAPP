import { describe, expect, it } from 'vitest';
import type { WhatsAppStatus } from '../whatsapp/types';
import { getHealthReport, getReadiness } from './healthService';

function status(overrides: Partial<WhatsAppStatus> = {}): WhatsAppStatus {
  return {
    state: 'disabled',
    reconnectAttempt: 0,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('getHealthReport', () => {
  it('reflects the WhatsApp state it was given', () => {
    const report = getHealthReport({
      whatsapp: status({ state: 'connected', lastConnectedAt: '2026-01-01T00:00:00.000Z' }),
    });
    expect(report.components.whatsapp.status).toBe('connected');
    expect(report.components.whatsapp.lastConnectedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('reports database as not_implemented (Phase 3 not built yet)', () => {
    const report = getHealthReport({ whatsapp: status() });
    expect(report.components.database.status).toBe('not_implemented');
  });

  it('never reports whatsapp status as "ok"/"not_implemented" placeholders — always the real state', () => {
    const report = getHealthReport({ whatsapp: status({ state: 'awaiting_qr' }) });
    expect(report.components.whatsapp.status).toBe('awaiting_qr');
  });

  it('keeps top-level status "ok" (liveness) even while WhatsApp is reconnecting', () => {
    const report = getHealthReport({ whatsapp: status({ state: 'reconnecting' }) });
    expect(report.status).toBe('ok');
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
