import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { AccountSettingsRepository } from './accountSettingsRepository';
import { FakeSupabaseClient } from './fakeSupabaseClient';

function repo(): AccountSettingsRepository {
  return new AccountSettingsRepository(new FakeSupabaseClient() as unknown as SupabaseClient);
}

describe('AccountSettingsRepository', () => {
  it('ensure() creates safe defaults (call handling off, LOG_ONLY) for a new account', async () => {
    const r = repo();
    const settings = await r.ensure('acct-1');
    expect(settings.callHandlingEnabled).toBe(false);
    expect(settings.callResponseAction).toBe('LOG_ONLY');
    expect(settings.callResponseMessage).toBeUndefined();
  });

  it('ensure() is idempotent — calling twice returns the same row, not a reset', async () => {
    const r = repo();
    await r.update(await (await r.ensure('acct-1')).accountId, {});
    await r.update('acct-1', { callHandlingEnabled: true, callResponseAction: 'AUTO_REJECT' });
    const again = await r.ensure('acct-1');
    expect(again.callHandlingEnabled).toBe(true);
    expect(again.callResponseAction).toBe('AUTO_REJECT');
  });

  it('update() only changes the fields provided', async () => {
    const r = repo();
    await r.ensure('acct-1');
    await r.update('acct-1', { callHandlingEnabled: true });
    const settings = await r.get('acct-1');
    expect(settings?.callHandlingEnabled).toBe(true);
    expect(settings?.callResponseAction).toBe('LOG_ONLY');
  });

  it('settings for one account never affect another', async () => {
    const r = repo();
    await r.ensure('acct-1');
    await r.ensure('acct-2');
    await r.update('acct-1', { callHandlingEnabled: true });
    const acct2 = await r.get('acct-2');
    expect(acct2?.callHandlingEnabled).toBe(false);
  });

  it('ensure() creates safe defaults for the Daily Owner Summary (off, 9am UTC, dashboard delivery)', async () => {
    const r = repo();
    const settings = await r.ensure('acct-1');
    expect(settings.dailySummaryEnabled).toBe(false);
    expect(settings.dailySummaryTimeMinutes).toBe(540);
    expect(settings.dailySummaryTimezone).toBe('UTC');
    expect(settings.dailySummaryDelivery).toBe('dashboard');
    expect(settings.dailySummaryMetrics.length).toBeGreaterThan(0);
    expect(settings.dailySummaryLastSentDate).toBeUndefined();
  });

  it('update() persists Daily Owner Summary settings', async () => {
    const r = repo();
    await r.ensure('acct-1');
    const updated = await r.update('acct-1', {
      dailySummaryEnabled: true,
      dailySummaryTimeMinutes: 1020,
      dailySummaryTimezone: 'America/New_York',
      dailySummaryDelivery: 'both',
      dailySummaryMetrics: ['messages_received', 'rules_fired'],
    });
    expect(updated).toMatchObject({
      dailySummaryEnabled: true,
      dailySummaryTimeMinutes: 1020,
      dailySummaryTimezone: 'America/New_York',
      dailySummaryDelivery: 'both',
      dailySummaryMetrics: ['messages_received', 'rules_fired'],
    });
  });

  it('can set and later clear dailySummaryLastSentDate (the dedup gate)', async () => {
    const r = repo();
    await r.ensure('acct-1');
    const withDate = await r.update('acct-1', { dailySummaryLastSentDate: '2026-01-01' });
    expect(withDate.dailySummaryLastSentDate).toBe('2026-01-01');

    const cleared = await r.update('acct-1', { dailySummaryLastSentDate: undefined });
    expect(cleared.dailySummaryLastSentDate).toBeUndefined();
  });
});
