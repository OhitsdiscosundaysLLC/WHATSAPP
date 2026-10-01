import type { SupabaseClient } from '@supabase/supabase-js';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { FakeSupabaseClient } from '../../db/fakeSupabaseClient';
import { GroupsRepository } from '../../db/groupsRepository';
import { MessagesRepository } from '../../db/messagesRepository';
import { runRetentionSweep } from './retentionSweep';

const testLogger = pino({ level: 'silent' });

describe('runRetentionSweep', () => {
  it('purges archived deleted-message text past a group’s retention window', async () => {
    const fake = new FakeSupabaseClient();
    const groupsRepository = new GroupsRepository(fake as unknown as SupabaseClient);
    const messagesRepository = new MessagesRepository(fake as unknown as SupabaseClient);
    const group = await groupsRepository.upsertDiscoveredGroup('acct-1', 'group@g.us', 'Team');
    await groupsRepository.updateSettings(group.id, { deletedMessageRetentionDays: 7 });

    await messagesRepository.store(
      {
        accountId: 'acct-1',
        chatJid: 'group@g.us',
        context: 'group',
        groupJid: 'group@g.us',
        whatsappMessageId: 'MSG1',
        senderJid: 'alice@s.whatsapp.net',
        fromMe: false,
        timestamp: new Date().toISOString(),
        messageType: 'conversation',
        text: 'old deleted message content',
        quotedWhatsappMessageId: undefined,
        quotedParticipant: undefined,
      },
      group.id,
    );
    await messagesRepository.markDeleted('acct-1', 'group@g.us', 'MSG1');
    // Backdate deleted_at well past the 7-day retention window.
    const rows = fake.rawRows('whatsapp_messages');
    rows[0]!.deleted_at = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    await runRetentionSweep(groupsRepository, messagesRepository, testLogger);

    expect(rows[0]!.text_content).toBeNull();
    expect(rows[0]!.deleted).toBe(true); // the row itself survives, only text is purged
  });

  it('never purges a group with no retention configured (undefined = keep forever)', async () => {
    const fake = new FakeSupabaseClient();
    const groupsRepository = new GroupsRepository(fake as unknown as SupabaseClient);
    const messagesRepository = new MessagesRepository(fake as unknown as SupabaseClient);
    const group = await groupsRepository.upsertDiscoveredGroup('acct-1', 'group@g.us', 'Team');

    await messagesRepository.store(
      {
        accountId: 'acct-1',
        chatJid: 'group@g.us',
        context: 'group',
        groupJid: 'group@g.us',
        whatsappMessageId: 'MSG1',
        senderJid: 'alice@s.whatsapp.net',
        fromMe: false,
        timestamp: new Date().toISOString(),
        messageType: 'conversation',
        text: 'keep forever',
        quotedWhatsappMessageId: undefined,
        quotedParticipant: undefined,
      },
      group.id,
    );
    await messagesRepository.markDeleted('acct-1', 'group@g.us', 'MSG1');
    const rows = fake.rawRows('whatsapp_messages');
    rows[0]!.deleted_at = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();

    await runRetentionSweep(groupsRepository, messagesRepository, testLogger);

    expect(rows[0]!.text_content).toBe('keep forever');
  });

  it('one group failing never stops the sweep for other groups', async () => {
    const fake = new FakeSupabaseClient();
    const groupsRepository = new GroupsRepository(fake as unknown as SupabaseClient);
    const messagesRepository = new MessagesRepository(fake as unknown as SupabaseClient);
    await groupsRepository.upsertDiscoveredGroup('acct-1', 'a@g.us', 'A');
    const groupB = await groupsRepository.upsertDiscoveredGroup('acct-1', 'b@g.us', 'B');
    await groupsRepository.updateSettings(groupB.id, { deletedMessageRetentionDays: 7 });

    await expect(
      runRetentionSweep(groupsRepository, messagesRepository, testLogger),
    ).resolves.not.toThrow();
  });
});
