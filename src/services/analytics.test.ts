import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { FakeSupabaseClient } from '../db/fakeSupabaseClient';
import { GroupsRepository } from '../db/groupsRepository';
import { computeAnalytics } from './analytics';

function supabaseOf(fake: FakeSupabaseClient): SupabaseClient {
  return fake as unknown as SupabaseClient;
}

async function seed(
  fake: FakeSupabaseClient,
  table: string,
  row: Record<string, unknown>,
): Promise<void> {
  const supabase = supabaseOf(fake);
  const { error } = await supabase.from(table).insert({ id: randomUUID(), ...row });
  if (error) throw new Error(error.message);
}

describe('computeAnalytics', () => {
  it('totals real counts over the whole range, scoped to one account', async () => {
    const fake = new FakeSupabaseClient();
    await seed(fake, 'whatsapp_messages', {
      account_id: 'acct-1',
      from_me: false,
      created_at: '2026-03-10T12:00:00.000Z',
    });
    await seed(fake, 'whatsapp_messages', {
      account_id: 'acct-1',
      from_me: false,
      created_at: '2026-03-12T12:00:00.000Z',
    });
    await seed(fake, 'whatsapp_messages', {
      account_id: 'acct-2',
      from_me: false,
      created_at: '2026-03-12T12:00:00.000Z',
    });

    const result = await computeAnalytics(
      supabaseOf(fake),
      'acct-1',
      new Date('2026-03-01T00:00:00.000Z'),
      new Date('2026-03-31T23:59:59.999Z'),
    );

    const messagesReceived = result.totals.find((m) => m.id === 'messages_received');
    expect(messagesReceived?.value).toBe(2);
  });

  it('builds a daily series across the range, filling zero for quiet days', async () => {
    const fake = new FakeSupabaseClient();
    await seed(fake, 'whatsapp_messages', {
      account_id: 'acct-1',
      from_me: false,
      created_at: '2026-03-01T12:00:00.000Z',
    });
    await seed(fake, 'whatsapp_messages', {
      account_id: 'acct-1',
      from_me: false,
      created_at: '2026-03-01T15:00:00.000Z',
    });
    await seed(fake, 'whatsapp_messages', {
      account_id: 'acct-1',
      from_me: false,
      created_at: '2026-03-03T09:00:00.000Z',
    });

    const result = await computeAnalytics(
      supabaseOf(fake),
      'acct-1',
      new Date('2026-03-01T00:00:00.000Z'),
      new Date('2026-03-03T23:59:59.999Z'),
    );

    expect(result.messagesReceivedByDay).toEqual([
      { date: '2026-03-01', value: 2 },
      { date: '2026-03-02', value: 0 },
      { date: '2026-03-03', value: 1 },
    ]);
  });

  it('ranks the top groups by real message counts and resolves their subjects', async () => {
    const fake = new FakeSupabaseClient();
    const groupsRepository = new GroupsRepository(supabaseOf(fake));
    const busyGroup = await groupsRepository.upsertDiscoveredGroup(
      'acct-1',
      'busy@g.us',
      'Busy Group',
    );
    const quietGroup = await groupsRepository.upsertDiscoveredGroup(
      'acct-1',
      'quiet@g.us',
      'Quiet Group',
    );

    for (let i = 0; i < 3; i++) {
      await seed(fake, 'whatsapp_messages', {
        account_id: 'acct-1',
        from_me: false,
        group_id: busyGroup.id,
        created_at: '2026-03-10T12:00:00.000Z',
      });
    }
    await seed(fake, 'whatsapp_messages', {
      account_id: 'acct-1',
      from_me: false,
      group_id: quietGroup.id,
      created_at: '2026-03-10T12:00:00.000Z',
    });
    // A private-contact message (no group_id) must never show up as a "group".
    await seed(fake, 'whatsapp_messages', {
      account_id: 'acct-1',
      from_me: false,
      group_id: null,
      created_at: '2026-03-10T12:00:00.000Z',
    });

    const result = await computeAnalytics(
      supabaseOf(fake),
      'acct-1',
      new Date('2026-03-01T00:00:00.000Z'),
      new Date('2026-03-31T23:59:59.999Z'),
    );

    expect(result.topGroups).toEqual([
      { groupId: busyGroup.id, subject: 'Busy Group', messageCount: 3 },
      { groupId: quietGroup.id, subject: 'Quiet Group', messageCount: 1 },
    ]);
  });

  it('sums real AI token usage, never an invented dollar estimate', async () => {
    const fake = new FakeSupabaseClient();
    await seed(fake, 'whatsapp_ai_usage', {
      account_id: 'acct-1',
      prompt_tokens: 100,
      completion_tokens: 40,
      created_at: '2026-03-10T12:00:00.000Z',
    });
    await seed(fake, 'whatsapp_ai_usage', {
      account_id: 'acct-1',
      prompt_tokens: 50,
      completion_tokens: 20,
      created_at: '2026-03-15T12:00:00.000Z',
    });

    const result = await computeAnalytics(
      supabaseOf(fake),
      'acct-1',
      new Date('2026-03-01T00:00:00.000Z'),
      new Date('2026-03-31T23:59:59.999Z'),
    );

    expect(result.aiTokensUsed).toEqual({ promptTokens: 150, completionTokens: 60 });
    expect(result).not.toHaveProperty('estimatedCost');
  });
});
