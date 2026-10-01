import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { AiUsageRepository } from '../db/aiUsageRepository';
import { FakeSupabaseClient } from '../db/fakeSupabaseClient';
import { checkAiUsageAllowed } from './aiUsagePolicy';

function repo(): { fake: FakeSupabaseClient; repository: AiUsageRepository } {
  const fake = new FakeSupabaseClient();
  return { fake, repository: new AiUsageRepository(fake as unknown as SupabaseClient) };
}

describe('checkAiUsageAllowed', () => {
  it('allows the first call when no prior usage exists', async () => {
    const { repository } = repo();
    const result = await checkAiUsageAllowed(
      'group-1',
      { aiCooldownSeconds: 60, aiMaxResponsesPerHour: undefined },
      repository,
    );
    expect(result.allowed).toBe(true);
  });

  it('blocks a call within the cooldown window after a successful call', async () => {
    const { repository } = repo();
    await repository.record({
      accountId: 'acct-1',
      groupId: 'group-1',
      ruleId: undefined,
      reason: 'auto_reply_generate',
      model: 'gpt-4o-mini',
      promptTokens: 10,
      completionTokens: 5,
      latencyMs: 100,
      success: true,
      error: undefined,
    });

    const result = await checkAiUsageAllowed(
      'group-1',
      { aiCooldownSeconds: 3600, aiMaxResponsesPerHour: undefined },
      repository,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/cooldown/i);
  });

  it('a FAILED call never counts toward the cooldown', async () => {
    const { repository } = repo();
    await repository.record({
      accountId: 'acct-1',
      groupId: 'group-1',
      ruleId: undefined,
      reason: 'auto_reply_generate',
      model: 'gpt-4o-mini',
      promptTokens: undefined,
      completionTokens: undefined,
      latencyMs: 100,
      success: false,
      error: 'timeout',
    });

    const result = await checkAiUsageAllowed(
      'group-1',
      { aiCooldownSeconds: 3600, aiMaxResponsesPerHour: undefined },
      repository,
    );
    expect(result.allowed).toBe(true);
  });

  it('blocks once the max-responses-per-hour limit is reached', async () => {
    const { repository } = repo();
    for (let i = 0; i < 3; i++) {
      await repository.record({
        accountId: 'acct-1',
        groupId: 'group-1',
        ruleId: undefined,
        reason: 'auto_reply_generate',
        model: 'gpt-4o-mini',
        promptTokens: 1,
        completionTokens: 1,
        latencyMs: 10,
        success: true,
        error: undefined,
      });
    }

    const result = await checkAiUsageAllowed(
      'group-1',
      { aiCooldownSeconds: 0, aiMaxResponsesPerHour: 3 },
      repository,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/max responses/i);
  });

  it('one group reaching its limit never blocks a different group', async () => {
    const { repository } = repo();
    for (let i = 0; i < 5; i++) {
      await repository.record({
        accountId: 'acct-1',
        groupId: 'group-1',
        ruleId: undefined,
        reason: 'auto_reply_generate',
        model: 'gpt-4o-mini',
        promptTokens: 1,
        completionTokens: 1,
        latencyMs: 10,
        success: true,
        error: undefined,
      });
    }

    const result = await checkAiUsageAllowed(
      'group-2',
      { aiCooldownSeconds: 60, aiMaxResponsesPerHour: 1 },
      repository,
    );
    expect(result.allowed).toBe(true);
  });

  it('cooldownSeconds=0 and maxResponsesPerHour=undefined means unlimited', async () => {
    const { repository } = repo();
    for (let i = 0; i < 20; i++) {
      await repository.record({
        accountId: 'acct-1',
        groupId: 'group-1',
        ruleId: undefined,
        reason: 'auto_reply_generate',
        model: 'gpt-4o-mini',
        promptTokens: 1,
        completionTokens: 1,
        latencyMs: 10,
        success: true,
        error: undefined,
      });
    }
    const result = await checkAiUsageAllowed(
      'group-1',
      { aiCooldownSeconds: 0, aiMaxResponsesPerHour: undefined },
      repository,
    );
    expect(result.allowed).toBe(true);
  });
});
