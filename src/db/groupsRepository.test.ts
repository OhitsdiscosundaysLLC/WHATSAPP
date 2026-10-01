import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { FakeSupabaseClient } from './fakeSupabaseClient';
import { DEFAULT_GROUP_SETTINGS, GroupsRepository } from './groupsRepository';

function repo(): { repo: GroupsRepository; fake: FakeSupabaseClient } {
  const fake = new FakeSupabaseClient();
  return { repo: new GroupsRepository(fake as unknown as SupabaseClient), fake };
}

describe('GroupsRepository', () => {
  it('upsertDiscoveredGroup creates a new group with safe-default settings', async () => {
    const { repo: r } = repo();
    const group = await r.upsertDiscoveredGroup('acct-1', '123@g.us', 'Team Chat');
    expect(group.whatsappGroupJid).toBe('123@g.us');
    expect(group.subject).toBe('Team Chat');

    const settings = await r.getSettings(group.id);
    expect(settings).toMatchObject(DEFAULT_GROUP_SETTINGS);
    expect(settings?.botEnabled).toBe(false);
    expect(settings?.monitoringEnabled).toBe(false);
    expect(settings?.aiEnabled).toBe(false);
  });

  it('upsertDiscoveredGroup is idempotent by (account, JID) — identity is the JID, not the name', async () => {
    const { repo: r } = repo();
    const a = await r.upsertDiscoveredGroup('acct-1', '123@g.us', 'Team Chat');
    const b = await r.upsertDiscoveredGroup('acct-1', '123@g.us', 'Team Chat');
    expect(b.id).toBe(a.id);
  });

  it('a renamed group updates subject in place rather than creating a duplicate row', async () => {
    const { repo: r } = repo();
    const original = await r.upsertDiscoveredGroup('acct-1', '123@g.us', 'Old Name');
    const renamed = await r.upsertDiscoveredGroup('acct-1', '123@g.us', 'New Name');

    expect(renamed.id).toBe(original.id);
    expect(renamed.subject).toBe('New Name');
    const all = await r.listByAccount('acct-1');
    expect(all).toHaveLength(1);
  });

  it('the same JID under two different accounts produces two separate groups', async () => {
    const { repo: r } = repo();
    const g1 = await r.upsertDiscoveredGroup('acct-1', '123@g.us', 'Shared Name');
    const g2 = await r.upsertDiscoveredGroup('acct-2', '123@g.us', 'Shared Name');
    expect(g1.id).not.toBe(g2.id);
  });

  it('updateSettings for one group never affects another group (isolation)', async () => {
    const { repo: r } = repo();
    const a = await r.upsertDiscoveredGroup('acct-1', 'a@g.us', 'A');
    const b = await r.upsertDiscoveredGroup('acct-1', 'b@g.us', 'B');

    await r.updateSettings(a.id, { botEnabled: true, monitoringEnabled: true });

    const settingsA = await r.getSettings(a.id);
    const settingsB = await r.getSettings(b.id);
    expect(settingsA?.botEnabled).toBe(true);
    expect(settingsB?.botEnabled).toBe(false);
    expect(settingsB?.monitoringEnabled).toBe(false);
  });

  it('updateSettings only changes the fields provided, leaving the rest untouched', async () => {
    const { repo: r } = repo();
    const g = await r.upsertDiscoveredGroup('acct-1', 'a@g.us', 'A');
    await r.updateSettings(g.id, { botEnabled: true });
    await r.updateSettings(g.id, { monitoringEnabled: true });

    const settings = await r.getSettings(g.id);
    expect(settings?.botEnabled).toBe(true);
    expect(settings?.monitoringEnabled).toBe(true);
  });

  it('getByJid looks up a group by its WhatsApp JID', async () => {
    const { repo: r } = repo();
    const created = await r.upsertDiscoveredGroup('acct-1', 'a@g.us', 'A');
    const found = await r.getByJid('acct-1', 'a@g.us');
    expect(found?.id).toBe(created.id);
    expect(await r.getByJid('acct-1', 'nonexistent@g.us')).toBeUndefined();
  });
});
