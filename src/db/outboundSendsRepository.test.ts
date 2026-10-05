import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { FakeSupabaseClient } from './fakeSupabaseClient';
import { OutboundSendsRepository } from './outboundSendsRepository';

function withFake() {
  const fake = new FakeSupabaseClient();
  fake.defineUniqueConstraint('whatsapp_outbound_sends', ['account_id', 'request_id']);
  const repo = new OutboundSendsRepository(fake as unknown as SupabaseClient);
  return { fake, repo };
}

const BASE_INPUT = {
  accountId: 'acct-1',
  requestId: 'req-1',
  groupId: 'group-1',
  contactId: undefined,
  destinationJid: 'group@g.us',
  messageType: 'text' as const,
  textBody: 'hello',
  caption: undefined,
  viewOnce: false,
  fileName: undefined,
  mimeType: undefined,
  fileSizeBytes: undefined,
};

describe('OutboundSendsRepository', () => {
  it('reserve() creates a pending row, finalize() marks it sent with the WhatsApp message id', async () => {
    const { repo } = withFake();
    const reserved = await repo.reserve(BASE_INPUT);
    expect(reserved).toBeDefined();
    expect(reserved!.status).toBe('pending');

    await repo.finalize(reserved!.id, { status: 'sent', whatsappMessageId: 'WAMID-1' });

    const found = await repo.findByRequestId('acct-1', 'req-1');
    expect(found).toMatchObject({ status: 'sent', whatsappMessageId: 'WAMID-1' });
  });

  it('finalize() can mark a reservation failed with an error message', async () => {
    const { repo } = withFake();
    const reserved = await repo.reserve({ ...BASE_INPUT, requestId: 'req-2' });

    await repo.finalize(reserved!.id, { status: 'failed', errorMessage: 'not connected' });

    const found = await repo.findByRequestId('acct-1', 'req-2');
    expect(found).toMatchObject({ status: 'failed', errorMessage: 'not connected' });
  });

  it('a second reserve() with the same (account_id, request_id) is rejected, not double-reserved', async () => {
    const { repo } = withFake();
    const first = await repo.reserve({ ...BASE_INPUT, requestId: 'req-dup' });
    expect(first).toBeDefined();

    const second = await repo.reserve({ ...BASE_INPUT, requestId: 'req-dup' });
    expect(second).toBeUndefined();
  });

  it('the exact same (account_id, request_id) reserved concurrently (Promise.all) lets exactly one through', async () => {
    const { repo } = withFake();
    const [a, b] = await Promise.all([
      repo.reserve({ ...BASE_INPUT, requestId: 'req-concurrent' }),
      repo.reserve({ ...BASE_INPUT, requestId: 'req-concurrent' }),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it('a different account can reuse the same request_id — scoped per account, not globally', async () => {
    const { repo } = withFake();
    const a = await repo.reserve({ ...BASE_INPUT, accountId: 'acct-1', requestId: 'shared-id' });
    const b = await repo.reserve({ ...BASE_INPUT, accountId: 'acct-2', requestId: 'shared-id' });
    expect(a).toBeDefined();
    expect(b).toBeDefined();
  });

  it('findByRequestId returns undefined for a request that was never reserved', async () => {
    const { repo } = withFake();
    expect(await repo.findByRequestId('acct-1', 'never-happened')).toBeUndefined();
  });

  it('list() returns newest-first and can be scoped to one account', async () => {
    const { repo } = withFake();
    await repo.reserve({ ...BASE_INPUT, accountId: 'acct-1', requestId: 'r1' });
    await repo.reserve({ ...BASE_INPUT, accountId: 'acct-2', requestId: 'r2' });
    await repo.reserve({ ...BASE_INPUT, accountId: 'acct-1', requestId: 'r3' });

    const all = await repo.list(undefined, 10);
    expect(all).toHaveLength(3);

    const acct1Only = await repo.list('acct-1', 10);
    expect(acct1Only.every((s) => s.accountId === 'acct-1')).toBe(true);
    expect(acct1Only).toHaveLength(2);
  });

  it('reserve() for a contact destination stores contactId, not groupId', async () => {
    const { repo } = withFake();
    const reserved = await repo.reserve({
      ...BASE_INPUT,
      requestId: 'req-contact',
      groupId: undefined,
      contactId: 'contact-1',
      destinationJid: 'a@s.whatsapp.net',
      messageType: 'image',
      textBody: undefined,
      caption: 'hi',
      viewOnce: true,
      mimeType: 'image/png',
      fileSizeBytes: 1234,
    });
    expect(reserved).toMatchObject({
      groupId: undefined,
      contactId: 'contact-1',
      messageType: 'image',
      caption: 'hi',
      viewOnce: true,
      mimeType: 'image/png',
      fileSizeBytes: 1234,
    });
  });
});
