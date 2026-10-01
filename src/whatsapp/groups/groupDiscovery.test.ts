import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { FakeSupabaseClient } from '../../db/fakeSupabaseClient';
import { GroupsRepository } from '../../db/groupsRepository';
import { handleDiscoveredGroups } from './groupDiscovery';

describe('handleDiscoveredGroups', () => {
  it('upserts every discovered group with safe-default settings', async () => {
    const fake = new FakeSupabaseClient();
    const groupsRepository = new GroupsRepository(fake as unknown as SupabaseClient);

    await handleDiscoveredGroups(
      'acct-1',
      [
        { jid: 'a@g.us', subject: 'Team A' },
        { jid: 'b@g.us', subject: 'Team B' },
      ],
      groupsRepository,
    );

    const groups = await groupsRepository.listByAccount('acct-1');
    expect(groups).toHaveLength(2);
    for (const group of groups) {
      const settings = await groupsRepository.getSettings(group.id);
      expect(settings?.botEnabled).toBe(false);
      expect(settings?.monitoringEnabled).toBe(false);
    }
  });

  it('re-running discovery for the same groups does not create duplicates', async () => {
    const fake = new FakeSupabaseClient();
    const groupsRepository = new GroupsRepository(fake as unknown as SupabaseClient);
    const groups = [{ jid: 'a@g.us', subject: 'Team A' }];

    await handleDiscoveredGroups('acct-1', groups, groupsRepository);
    await handleDiscoveredGroups('acct-1', groups, groupsRepository);

    expect(await groupsRepository.listByAccount('acct-1')).toHaveLength(1);
  });

  it('a rename updates the existing group rather than creating a new one', async () => {
    const fake = new FakeSupabaseClient();
    const groupsRepository = new GroupsRepository(fake as unknown as SupabaseClient);

    await handleDiscoveredGroups(
      'acct-1',
      [{ jid: 'a@g.us', subject: 'Old Name' }],
      groupsRepository,
    );
    await handleDiscoveredGroups(
      'acct-1',
      [{ jid: 'a@g.us', subject: 'New Name' }],
      groupsRepository,
    );

    const groups = await groupsRepository.listByAccount('acct-1');
    expect(groups).toHaveLength(1);
    expect(groups[0]?.subject).toBe('New Name');
  });
});
