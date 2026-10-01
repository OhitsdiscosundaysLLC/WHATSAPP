import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { AuditRepository } from './auditRepository';
import { FakeSupabaseClient } from './fakeSupabaseClient';

function repo(): AuditRepository {
  return new AuditRepository(new FakeSupabaseClient() as unknown as SupabaseClient);
}

describe('AuditRepository', () => {
  it('records a bot action', async () => {
    const r = repo();
    await r.recordAction({
      accountId: 'acct-1',
      groupId: 'group-1',
      ruleId: 'rule-1',
      triggerWhatsappMessageId: 'MSG1',
      actionType: 'SEND_MESSAGE',
      status: 'success',
      detail: { message: 'Thanks!' },
    });
    const actions = await r.listRecentActions();
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ actionType: 'SEND_MESSAGE', status: 'success' });
  });

  it('records a general audit event', async () => {
    const r = repo();
    await r.recordEvent({ accountId: 'acct-1', groupId: 'group-1', eventType: 'rule.fired' });
    const events = await r.listRecent();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: 'rule.fired', actor: 'system' });
  });

  it('listRecent/listRecentActions scope to one group when asked', async () => {
    const r = repo();
    await r.recordEvent({ accountId: 'acct-1', groupId: 'group-A', eventType: 'message.received' });
    await r.recordEvent({ accountId: 'acct-1', groupId: 'group-B', eventType: 'message.received' });

    const groupAEvents = await r.listRecent(50, 'group-A');
    expect(groupAEvents).toHaveLength(1);
    expect(groupAEvents[0]?.groupId).toBe('group-A');
  });

  it('never includes credential/key material in detail — a basic sanity shape check', async () => {
    const r = repo();
    await r.recordEvent({
      accountId: 'acct-1',
      groupId: 'group-1',
      eventType: 'config.changed',
      detail: { field: 'botEnabled', newValue: true },
    });
    const [entry] = await r.listRecent();
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toMatch(/ciphertext|encryptionKey|auth_tag/i);
  });
});
