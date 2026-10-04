import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { AccountSettingsRepository } from '../db/accountSettingsRepository';
import { FakeSupabaseClient } from '../db/fakeSupabaseClient';
import { OwnerInboxRepository } from '../db/ownerInboxRepository';
import {
  computeDailySummary,
  formatSummaryText,
  runDailySummarySweep,
  type DailySummaryDeps,
} from './dailySummary';
import pino from 'pino';

const testLogger = pino({ level: 'silent' });

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

describe('computeDailySummary', () => {
  it('counts only rows for the target account within the target local day (UTC)', async () => {
    const fake = new FakeSupabaseClient();
    const inDay = '2026-03-15T12:00:00.000Z';
    const beforeDay = '2026-03-14T23:00:00.000Z';
    const afterDay = '2026-03-16T01:00:00.000Z';

    await seed(fake, 'whatsapp_messages', {
      account_id: 'acct-1',
      from_me: false,
      created_at: inDay,
    });
    await seed(fake, 'whatsapp_messages', {
      account_id: 'acct-1',
      from_me: false,
      created_at: beforeDay,
    });
    await seed(fake, 'whatsapp_messages', {
      account_id: 'acct-1',
      from_me: false,
      created_at: afterDay,
    });
    await seed(fake, 'whatsapp_messages', {
      account_id: 'acct-2', // different account — must never be counted
      from_me: false,
      created_at: inDay,
    });
    await seed(fake, 'whatsapp_messages', {
      account_id: 'acct-1',
      from_me: true, // the bot's own outgoing message — not "received"
      created_at: inDay,
    });

    const result = await computeDailySummary(
      supabaseOf(fake),
      'acct-1',
      ['messages_received'],
      'UTC',
      new Date('2026-03-15T18:00:00.000Z'),
    );

    expect(result.localDate).toBe('2026-03-15');
    expect(result.metrics).toEqual([
      { id: 'messages_received', label: 'Messages received', value: 1 },
    ]);
  });

  it('counts rules_fired from audit events, moderation and AI calls from their own tables', async () => {
    const fake = new FakeSupabaseClient();
    const day = '2026-03-15T12:00:00.000Z';

    await seed(fake, 'whatsapp_audit_logs', {
      account_id: 'acct-1',
      event_type: 'rule.fired',
      created_at: day,
    });
    await seed(fake, 'whatsapp_audit_logs', {
      account_id: 'acct-1',
      event_type: 'escalation.fired',
      created_at: day,
    });
    await seed(fake, 'whatsapp_audit_logs', {
      account_id: 'acct-1',
      event_type: 'message.received', // not a "fired" event — must not count
      created_at: day,
    });
    await seed(fake, 'bot_actions', {
      account_id: 'acct-1',
      action_type: 'WARN',
      status: 'success',
      created_at: day,
    });
    await seed(fake, 'bot_actions', {
      account_id: 'acct-1',
      action_type: 'WARN',
      status: 'skipped', // not successfully taken — must not count
      created_at: day,
    });
    await seed(fake, 'whatsapp_ai_usage', { account_id: 'acct-1', created_at: day });

    const result = await computeDailySummary(
      supabaseOf(fake),
      'acct-1',
      ['rules_fired', 'moderation_actions_taken', 'ai_calls_made'],
      'UTC',
      new Date('2026-03-15T18:00:00.000Z'),
    );

    expect(result.metrics).toEqual([
      { id: 'rules_fired', label: 'Rules fired', value: 2 },
      { id: 'moderation_actions_taken', label: 'Moderation actions taken', value: 1 },
      { id: 'ai_calls_made', label: 'AI calls made', value: 1 },
    ]);
  });

  it('skips an unrecognized metric id rather than guessing', async () => {
    const fake = new FakeSupabaseClient();
    const result = await computeDailySummary(
      supabaseOf(fake),
      'acct-1',
      ['not_a_real_metric'],
      'UTC',
    );
    expect(result.metrics).toEqual([]);
  });

  it('respects the account timezone, not UTC, when drawing the day boundary', async () => {
    const fake = new FakeSupabaseClient();
    // 2026-03-15 23:30 America/New_York is still 2026-03-16 03:30 UTC.
    await seed(fake, 'whatsapp_messages', {
      account_id: 'acct-1',
      from_me: false,
      created_at: '2026-03-16T03:30:00.000Z',
    });

    const resultEasternDay = await computeDailySummary(
      supabaseOf(fake),
      'acct-1',
      ['messages_received'],
      'America/New_York',
      new Date('2026-03-15T20:00:00.000Z'), // 3pm Eastern on the 15th
    );
    expect(resultEasternDay.localDate).toBe('2026-03-15');
    expect(resultEasternDay.metrics[0]?.value).toBe(1);

    const resultUtcDay = await computeDailySummary(
      supabaseOf(fake),
      'acct-1',
      ['messages_received'],
      'UTC',
      new Date('2026-03-15T20:00:00.000Z'),
    );
    expect(resultUtcDay.metrics[0]?.value).toBe(0); // that message falls on UTC's March 16th
  });
});

describe('formatSummaryText', () => {
  it('renders a human-readable line per metric', () => {
    const text = formatSummaryText({
      accountId: 'acct-1',
      localDate: '2026-03-15',
      metrics: [{ id: 'messages_received', label: 'Messages received', value: 7 }],
    });
    expect(text).toContain('2026-03-15');
    expect(text).toContain('Messages received: 7');
  });
});

describe('runDailySummarySweep', () => {
  function deps(
    fake: FakeSupabaseClient,
    sendTextMessage = vi.fn(async () => {}),
  ): DailySummaryDeps {
    return {
      supabase: supabaseOf(fake),
      sendTextMessage,
      ownerJids: ['15550001111@s.whatsapp.net'],
      logger: testLogger,
    };
  }

  it('does nothing for an account with dailySummaryEnabled off', async () => {
    const fake = new FakeSupabaseClient();
    const accountSettingsRepository = new AccountSettingsRepository(supabaseOf(fake));
    await accountSettingsRepository.ensure('acct-1');

    const sendTextMessage = vi.fn(async () => {});
    await runDailySummarySweep(['acct-1'], deps(fake, sendTextMessage));

    expect(sendTextMessage).not.toHaveBeenCalled();
  });

  it('delivers to the dashboard (Owner Inbox) and marks the local date sent', async () => {
    const fake = new FakeSupabaseClient();
    const accountSettingsRepository = new AccountSettingsRepository(supabaseOf(fake));
    await accountSettingsRepository.ensure('acct-1');
    await accountSettingsRepository.update('acct-1', {
      dailySummaryEnabled: true,
      dailySummaryTimeMinutes: 0, // always "due" once enabled
      dailySummaryTimezone: 'UTC',
      dailySummaryDelivery: 'dashboard',
    });

    await runDailySummarySweep(['acct-1'], deps(fake));

    const ownerInbox = new OwnerInboxRepository(supabaseOf(fake));
    const items = await ownerInbox.list('acct-1');
    expect(items.find((i) => i.title.startsWith('Daily Summary'))).toBeTruthy();

    const after = await accountSettingsRepository.get('acct-1');
    expect(after?.dailySummaryLastSentDate).toBeTruthy();
  });

  it('delivers via WhatsApp when delivery is "whatsapp", never writing to the dashboard', async () => {
    const fake = new FakeSupabaseClient();
    const accountSettingsRepository = new AccountSettingsRepository(supabaseOf(fake));
    await accountSettingsRepository.ensure('acct-1');
    await accountSettingsRepository.update('acct-1', {
      dailySummaryEnabled: true,
      dailySummaryTimeMinutes: 0,
      dailySummaryTimezone: 'UTC',
      dailySummaryDelivery: 'whatsapp',
    });

    const sendTextMessage = vi.fn(async () => {});
    await runDailySummarySweep(['acct-1'], deps(fake, sendTextMessage));

    expect(sendTextMessage).toHaveBeenCalledWith(
      'acct-1',
      '15550001111@s.whatsapp.net',
      expect.stringContaining('Daily Summary'),
    );
    const ownerInbox = new OwnerInboxRepository(supabaseOf(fake));
    expect(await ownerInbox.list('acct-1')).toHaveLength(0);
  });

  it('never sends twice for the same local day (dedup)', async () => {
    const fake = new FakeSupabaseClient();
    const accountSettingsRepository = new AccountSettingsRepository(supabaseOf(fake));
    await accountSettingsRepository.ensure('acct-1');
    await accountSettingsRepository.update('acct-1', {
      dailySummaryEnabled: true,
      dailySummaryTimeMinutes: 0,
      dailySummaryTimezone: 'UTC',
      dailySummaryDelivery: 'whatsapp',
    });

    const sendTextMessage = vi.fn(async () => {});
    const d = deps(fake, sendTextMessage);
    await runDailySummarySweep(['acct-1'], d);
    await runDailySummarySweep(['acct-1'], d); // same tick/day — must be a no-op

    expect(sendTextMessage).toHaveBeenCalledTimes(1);
  });

  it("one account's failure never stops the sweep for the rest", async () => {
    const fake = new FakeSupabaseClient();
    const accountSettingsRepository = new AccountSettingsRepository(supabaseOf(fake));
    await accountSettingsRepository.ensure('acct-1');
    await accountSettingsRepository.update('acct-1', {
      dailySummaryEnabled: true,
      dailySummaryTimeMinutes: 0,
      dailySummaryTimezone: 'not-a-real-timezone',
      dailySummaryDelivery: 'dashboard',
    });
    await accountSettingsRepository.ensure('acct-2');
    await accountSettingsRepository.update('acct-2', {
      dailySummaryEnabled: true,
      dailySummaryTimeMinutes: 0,
      dailySummaryTimezone: 'UTC',
      dailySummaryDelivery: 'dashboard',
    });

    await runDailySummarySweep(['acct-1', 'acct-2'], deps(fake));

    const ownerInbox = new OwnerInboxRepository(supabaseOf(fake));
    expect(await ownerInbox.list('acct-1')).toHaveLength(0); // bad timezone — never due, never throws out
    expect(await ownerInbox.list('acct-2')).toHaveLength(1);
  });
});
