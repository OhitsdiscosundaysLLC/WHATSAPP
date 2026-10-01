import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { FakeSupabaseClient } from './fakeSupabaseClient';
import { NotificationCooldownRepository } from './notificationCooldownRepository';

function repo(): NotificationCooldownRepository {
  return new NotificationCooldownRepository(new FakeSupabaseClient() as unknown as SupabaseClient);
}

describe('NotificationCooldownRepository', () => {
  it('allows the first notification for a key', async () => {
    const r = repo();
    expect(await r.tryNotify('acct-1', 'deleted_message:group-1', 30)).toBe(true);
  });

  it('blocks a second notification for the same key within the cooldown', async () => {
    const r = repo();
    expect(await r.tryNotify('acct-1', 'deleted_message:group-1', 3600)).toBe(true);
    expect(await r.tryNotify('acct-1', 'deleted_message:group-1', 3600)).toBe(false);
  });

  it('different keys never block each other', async () => {
    const r = repo();
    expect(await r.tryNotify('acct-1', 'deleted_message:group-1', 3600)).toBe(true);
    expect(await r.tryNotify('acct-1', 'deleted_message:group-2', 3600)).toBe(true);
  });

  it('different accounts never block each other for the same key', async () => {
    const r = repo();
    expect(await r.tryNotify('acct-1', 'call:123', 3600)).toBe(true);
    expect(await r.tryNotify('acct-2', 'call:123', 3600)).toBe(true);
  });

  it('allows again once the cooldown has elapsed', async () => {
    const r = repo();
    expect(await r.tryNotify('acct-1', 'key', 0.01)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await r.tryNotify('acct-1', 'key', 0.01)).toBe(true);
  });
});
