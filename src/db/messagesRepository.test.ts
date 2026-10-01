import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import type { NormalizedMessageEvent } from '../whatsapp/events/messageNormalizer';
import { FakeSupabaseClient } from './fakeSupabaseClient';
import { MessagesRepository } from './messagesRepository';

function event(overrides: Partial<NormalizedMessageEvent> = {}): NormalizedMessageEvent {
  return {
    accountId: 'acct-1',
    chatJid: 'group@g.us',
    context: 'group',
    groupJid: 'group@g.us',
    whatsappMessageId: 'MSG1',
    senderJid: 'sender@s.whatsapp.net',
    fromMe: false,
    timestamp: new Date().toISOString(),
    messageType: 'conversation',
    text: 'hello',
    quotedWhatsappMessageId: undefined,
    quotedParticipant: undefined,
    ...overrides,
  };
}

function withFake(): { repo: MessagesRepository; fake: FakeSupabaseClient } {
  const fake = new FakeSupabaseClient();
  fake.defineUniqueConstraint('whatsapp_processed_events', [
    'account_id',
    'chat_jid',
    'whatsapp_message_id',
  ]);
  return { repo: new MessagesRepository(fake as unknown as SupabaseClient), fake };
}

describe('MessagesRepository', () => {
  it('markProcessed returns true the first time a message is seen', async () => {
    const { repo } = withFake();
    expect(await repo.markProcessed(event())).toBe(true);
  });

  it('markProcessed returns false for a redelivered (duplicate) event — idempotency', async () => {
    const { repo } = withFake();
    await repo.markProcessed(event());
    expect(await repo.markProcessed(event())).toBe(false);
  });

  it('the same message id in a different chat is not treated as a duplicate', async () => {
    const { repo } = withFake();
    await repo.markProcessed(event({ chatJid: 'groupA@g.us' }));
    expect(await repo.markProcessed(event({ chatJid: 'groupB@g.us' }))).toBe(true);
  });

  it('the same message id on a different account is not treated as a duplicate', async () => {
    const { repo } = withFake();
    await repo.markProcessed(event({ accountId: 'acct-1' }));
    expect(await repo.markProcessed(event({ accountId: 'acct-2' }))).toBe(true);
  });

  it('store() persists a normalized message when monitoring is enabled', async () => {
    const { repo, fake } = withFake();
    await repo.store(event({ text: 'Congrats sir' }), 'group-uuid-1');
    const rows = fake.rawRows('whatsapp_messages');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ text_content: 'Congrats sir', group_id: 'group-uuid-1' });
  });

  it('store() does not store giant raw payloads — only the normalized fields', async () => {
    const { repo, fake } = withFake();
    await repo.store(event(), 'group-uuid-1');
    const row = fake.rawRows('whatsapp_messages')[0]!;
    expect(Object.keys(row).sort()).toEqual(
      [
        'account_id',
        'chat_jid',
        'created_at',
        'from_me',
        'group_id',
        'message_type',
        'quoted_whatsapp_message_id',
        'sender_jid',
        'text_content',
        'whatsapp_message_id',
      ].sort(),
    );
  });
});
