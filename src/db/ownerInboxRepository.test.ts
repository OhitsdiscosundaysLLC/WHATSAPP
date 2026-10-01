import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { FakeSupabaseClient } from './fakeSupabaseClient';
import { OwnerInboxRepository } from './ownerInboxRepository';

function repo(fake: FakeSupabaseClient): OwnerInboxRepository {
  return new OwnerInboxRepository(fake as unknown as SupabaseClient);
}

describe('OwnerInboxRepository', () => {
  it('records an item and lists it back, unread and not dismissed by default', async () => {
    const fake = new FakeSupabaseClient();
    const inbox = repo(fake);

    await inbox.record({
      accountId: 'acct-1',
      groupId: 'group-1',
      category: 'deleted_message',
      title: 'A message was deleted in Team Chat',
      detail: { who: 'alice@s.whatsapp.net' },
    });

    const items = await inbox.list('acct-1');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      accountId: 'acct-1',
      groupId: 'group-1',
      category: 'deleted_message',
      title: 'A message was deleted in Team Chat',
      read: false,
      dismissed: false,
    });
  });

  it('account isolation: an item recorded for one account never appears in another account’s list', async () => {
    const fake = new FakeSupabaseClient();
    const inbox = repo(fake);
    await inbox.record({ accountId: 'acct-1', category: 'missed_call', title: 'Missed call' });
    await inbox.record({ accountId: 'acct-2', category: 'missed_call', title: 'Missed call' });

    const itemsForAcct1 = await inbox.list('acct-1');
    expect(itemsForAcct1).toHaveLength(1);
  });

  it('markRead flips read to true without dismissing', async () => {
    const fake = new FakeSupabaseClient();
    const inbox = repo(fake);
    await inbox.record({ accountId: 'acct-1', category: 'rule_fired', title: 'Rule fired' });
    const [item] = await inbox.list('acct-1');

    await inbox.markRead(item!.id);

    const [updated] = await inbox.list('acct-1', { includeDismissed: true });
    expect(updated).toMatchObject({ read: true, dismissed: false });
  });

  it('dismiss flips both dismissed and read to true, and dismissed items are excluded by default', async () => {
    const fake = new FakeSupabaseClient();
    const inbox = repo(fake);
    await inbox.record({ accountId: 'acct-1', category: 'ai_failure', title: 'AI failed' });
    const [item] = await inbox.list('acct-1');

    await inbox.dismiss(item!.id);

    expect(await inbox.list('acct-1')).toHaveLength(0);
    const [dismissed] = await inbox.list('acct-1', { includeDismissed: true });
    expect(dismissed).toMatchObject({ read: true, dismissed: true });
  });

  it('unreadOnly filters out already-read items', async () => {
    const fake = new FakeSupabaseClient();
    const inbox = repo(fake);
    await inbox.record({ accountId: 'acct-1', category: 'automation_failure', title: 'Failed' });
    const [item] = await inbox.list('acct-1');
    await inbox.markRead(item!.id);

    expect(await inbox.list('acct-1', { unreadOnly: true })).toHaveLength(0);
  });

  it('carries contactId for private-chat items, independent of groupId', async () => {
    const fake = new FakeSupabaseClient();
    const inbox = repo(fake);
    await inbox.record({
      accountId: 'acct-1',
      contactId: 'contact-1',
      category: 'deleted_message',
      title: 'A DM was deleted',
    });

    const [item] = await inbox.list('acct-1');
    expect(item).toMatchObject({ contactId: 'contact-1', groupId: undefined });
  });
});
