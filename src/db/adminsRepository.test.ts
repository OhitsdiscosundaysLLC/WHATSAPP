import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { AdminsRepository } from './adminsRepository';
import { FakeSupabaseClient } from './fakeSupabaseClient';

function repo(): { repo: AdminsRepository; fake: FakeSupabaseClient } {
  const fake = new FakeSupabaseClient();
  return { repo: new AdminsRepository(fake as unknown as SupabaseClient), fake };
}

describe('AdminsRepository', () => {
  it('adds an admin and lists it back for its account', async () => {
    const { repo: r } = repo();
    const admin = await r.add('acct-1', '15559998888', 'Assistant');
    expect(admin.phoneNumber).toBe('15559998888');
    expect(admin.label).toBe('Assistant');

    const list = await r.listByAccount('acct-1');
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(admin.id);
  });

  it('isolates admins per account', async () => {
    const { repo: r } = repo();
    await r.add('acct-1', '15559998888', undefined);
    await r.add('acct-2', '15557776666', undefined);

    expect(await r.listByAccount('acct-1')).toHaveLength(1);
    expect(await r.listByAccount('acct-2')).toHaveLength(1);
    expect(await r.listAll()).toHaveLength(2);
  });

  it('removes an admin', async () => {
    const { repo: r } = repo();
    const admin = await r.add('acct-1', '15559998888', undefined);
    await r.remove(admin.id);
    expect(await r.listByAccount('acct-1')).toHaveLength(0);
  });
});
