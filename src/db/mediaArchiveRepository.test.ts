import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { FakeSupabaseClient } from './fakeSupabaseClient';
import { MediaArchiveRepository } from './mediaArchiveRepository';

function supabaseOf(fake: FakeSupabaseClient): SupabaseClient {
  return fake as unknown as SupabaseClient;
}

describe('MediaArchiveRepository', () => {
  it('records and lists group-scoped media, newest first', async () => {
    const repo = new MediaArchiveRepository(supabaseOf(new FakeSupabaseClient()));
    await repo.record({
      accountId: 'acct-1',
      groupId: 'group-1',
      contactId: undefined,
      whatsappMessageId: 'MSG1',
      senderJid: 'alice@s.whatsapp.net',
      isViewOnce: false,
      storagePath: 'acct-1/group-group-1/MSG1',
      mimeType: 'image/jpeg',
      fileSizeBytes: 100,
      sha256: undefined,
    });
    // created_at has millisecond resolution — force a distinct timestamp so
    // "newest first" ordering isn't a coin flip between same-millisecond rows.
    await new Promise((resolve) => setTimeout(resolve, 2));
    await repo.record({
      accountId: 'acct-1',
      groupId: 'group-1',
      contactId: undefined,
      whatsappMessageId: 'MSG2',
      senderJid: 'bob@s.whatsapp.net',
      isViewOnce: true,
      storagePath: 'acct-1/group-group-1/MSG2',
      mimeType: 'video/mp4',
      fileSizeBytes: 200,
      sha256: undefined,
    });

    const items = await repo.listByGroup('group-1');
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.whatsappMessageId)).toEqual(['MSG2', 'MSG1']);
    expect(items[0]).toMatchObject({ groupId: 'group-1', contactId: undefined, isViewOnce: true });
  });

  it('records and lists contact-scoped media, never leaking into a group listing', async () => {
    const fake = new FakeSupabaseClient();
    const repo = new MediaArchiveRepository(supabaseOf(fake));
    await repo.record({
      accountId: 'acct-1',
      groupId: undefined,
      contactId: 'contact-1',
      whatsappMessageId: 'MSG3',
      senderJid: 'alice@s.whatsapp.net',
      isViewOnce: false,
      storagePath: 'acct-1/contact-contact-1/MSG3',
      mimeType: 'application/pdf',
      fileSizeBytes: 300,
      sha256: undefined,
    });

    const contactItems = await repo.listByContact('contact-1');
    expect(contactItems).toHaveLength(1);
    expect(contactItems[0]).toMatchObject({ contactId: 'contact-1', groupId: undefined });

    expect(await repo.listByGroup('contact-1')).toHaveLength(0);
  });

  it('findByMessageId looks up by account + whatsapp_message_id, scoped to the right account', async () => {
    const repo = new MediaArchiveRepository(supabaseOf(new FakeSupabaseClient()));
    await repo.record({
      accountId: 'acct-1',
      groupId: 'group-1',
      contactId: undefined,
      whatsappMessageId: 'MSG4',
      senderJid: 'alice@s.whatsapp.net',
      isViewOnce: false,
      storagePath: 'acct-1/group-group-1/MSG4',
      mimeType: 'image/png',
      fileSizeBytes: 400,
      sha256: 'deadbeef',
    });

    expect(await repo.findByMessageId('acct-1', 'MSG4')).toMatchObject({
      whatsappMessageId: 'MSG4',
      mimeType: 'image/png',
    });
    expect(await repo.findByMessageId('acct-other', 'MSG4')).toBeUndefined();
    expect(await repo.findByMessageId('acct-1', 'does-not-exist')).toBeUndefined();
  });
});
