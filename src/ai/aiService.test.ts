import type { SupabaseClient } from '@supabase/supabase-js';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { AiUsageRepository } from '../db/aiUsageRepository';
import { FakeSupabaseClient } from '../db/fakeSupabaseClient';
import type { AICompletionRequest, AICompletionResult, AIProvider } from './aiProvider';
import { AIService } from './aiService';

const testLogger = pino({ level: 'silent' });

function fakeProvider(impl: (req: AICompletionRequest) => Promise<AICompletionResult>): AIProvider {
  return { complete: vi.fn(impl) };
}

function setup(provider: AIProvider) {
  const fake = new FakeSupabaseClient();
  const usageRepository = new AiUsageRepository(fake as unknown as SupabaseClient);
  const service = new AIService(provider, usageRepository, testLogger);
  return { fake, usageRepository, service };
}

describe('AIService', () => {
  it('generateReply returns the provider text and logs successful usage', async () => {
    const provider = fakeProvider(async () => ({
      text: 'Hello there!',
      model: 'gpt-4o-mini',
      promptTokens: 20,
      completionTokens: 5,
    }));
    const { fake, service } = setup(provider);

    const text = await service.generateReply(
      { accountId: 'acct-1', groupId: 'group-1', ruleId: 'rule-1', reason: 'auto_reply_generate' },
      { ownerConfig: 'Be friendly', userMessage: 'hi' },
    );

    expect(text).toBe('Hello there!');
    const rows = fake.rawRows('whatsapp_ai_usage');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      success: true,
      reason: 'auto_reply_generate',
      model: 'gpt-4o-mini',
    });
  });

  it('never logs prompt or response text in whatsapp_ai_usage', async () => {
    const provider = fakeProvider(async () => ({
      text: 'super secret reply content',
      model: 'gpt-4o-mini',
      promptTokens: 1,
      completionTokens: 1,
    }));
    const { fake, service } = setup(provider);

    await service.generateReply(
      { accountId: 'acct-1', groupId: 'group-1', ruleId: undefined, reason: 'auto_reply_generate' },
      { ownerConfig: undefined, userMessage: 'a very private message' },
    );

    const row = fake.rawRows('whatsapp_ai_usage')[0];
    expect(JSON.stringify(row)).not.toContain('super secret');
    expect(JSON.stringify(row)).not.toContain('very private');
  });

  it('generateReply propagates the error and logs a failed usage row', async () => {
    const provider = fakeProvider(async () => {
      throw new Error('OpenAI API error: HTTP 500');
    });
    const { fake, service } = setup(provider);

    await expect(
      service.generateReply(
        {
          accountId: 'acct-1',
          groupId: 'group-1',
          ruleId: undefined,
          reason: 'auto_reply_generate',
        },
        { ownerConfig: undefined, userMessage: 'hi' },
      ),
    ).rejects.toThrow('OpenAI API error');

    const rows = fake.rawRows('whatsapp_ai_usage');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ success: false });
  });

  it('classify returns true only when the provider answers YES', async () => {
    const provider = fakeProvider(async () => ({
      text: 'YES',
      model: 'gpt-4o-mini',
      promptTokens: 5,
      completionTokens: 1,
    }));
    const { service } = setup(provider);

    const result = await service.classify(
      { accountId: 'acct-1', groupId: 'group-1', ruleId: 'rule-1', reason: 'auto_reply_classify' },
      { criteria: 'asks about business hours', userMessage: 'what time do you open?' },
    );
    expect(result).toBe(true);
  });

  it('classify returns false for a NO answer', async () => {
    const provider = fakeProvider(async () => ({
      text: 'NO',
      model: 'gpt-4o-mini',
      promptTokens: 5,
      completionTokens: 1,
    }));
    const { service } = setup(provider);

    const result = await service.classify(
      { accountId: 'acct-1', groupId: 'group-1', ruleId: 'rule-1', reason: 'auto_reply_classify' },
      { criteria: 'asks about business hours', userMessage: 'nice weather today' },
    );
    expect(result).toBe(false);
  });

  it('classify FAILS CLOSED (returns false, never throws) when the provider errors', async () => {
    const provider = fakeProvider(async () => {
      throw new Error('network error');
    });
    const { service } = setup(provider);

    const result = await service.classify(
      { accountId: 'acct-1', groupId: 'group-1', ruleId: undefined, reason: 'auto_reply_classify' },
      { criteria: 'anything', userMessage: 'hi' },
    );
    expect(result).toBe(false);
  });

  it("a usage-logging failure never breaks the caller's actual AI result", async () => {
    const provider = fakeProvider(async () => ({
      text: 'ok',
      model: 'gpt-4o-mini',
      promptTokens: 1,
      completionTokens: 1,
    }));
    const fake = new FakeSupabaseClient();
    const usageRepository = new AiUsageRepository(fake as unknown as SupabaseClient);
    vi.spyOn(usageRepository, 'record').mockRejectedValue(new Error('db down'));
    const service = new AIService(provider, usageRepository, testLogger);

    const text = await service.generateReply(
      { accountId: 'acct-1', groupId: 'group-1', ruleId: undefined, reason: 'auto_reply_generate' },
      { ownerConfig: undefined, userMessage: 'hi' },
    );
    expect(text).toBe('ok');
  });
});
