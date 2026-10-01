import { describe, expect, it, vi } from 'vitest';
import type { AiCallContext, AIService } from '../../ai/aiService';
import type { AutoReplyQualifyConfig } from '../ruleConfig';
import { classifyAutoReply } from './autoReplyClassifier';

const ctx: AiCallContext = {
  accountId: 'acct-1',
  groupId: 'group-1',
  ruleId: 'rule-1',
  reason: 'auto_reply_classify',
};

describe('classifyAutoReply — deterministic', () => {
  const config: AutoReplyQualifyConfig = {
    classifier: 'deterministic',
    mode: 'contains',
    phrases: ['hours'],
  };

  it('matches without ever touching AI', async () => {
    const aiService = { classify: vi.fn() } as unknown as AIService;
    const result = await classifyAutoReply('what are your hours?', config, aiService, ctx);
    expect(result).toBe(true);
    expect(aiService.classify).not.toHaveBeenCalled();
  });

  it('does not match', async () => {
    const result = await classifyAutoReply('nice weather', config, undefined, ctx);
    expect(result).toBe(false);
  });
});

describe('classifyAutoReply — ai', () => {
  const config: AutoReplyQualifyConfig = {
    classifier: 'ai',
    aiInstructions: 'asks about opening hours',
  };

  it('delegates to AIService.classify with the configured criteria', async () => {
    const classify = vi.fn().mockResolvedValue(true);
    const aiService = { classify } as unknown as AIService;

    const result = await classifyAutoReply('when do you open', config, aiService, ctx);

    expect(result).toBe(true);
    expect(classify).toHaveBeenCalledWith(ctx, {
      criteria: 'asks about opening hours',
      userMessage: 'when do you open',
    });
  });

  it('fails closed (false) when no AIService is available', async () => {
    const result = await classifyAutoReply('when do you open', config, undefined, ctx);
    expect(result).toBe(false);
  });

  it('never calls AI for an empty message', async () => {
    const classify = vi.fn();
    const aiService = { classify } as unknown as AIService;
    const result = await classifyAutoReply(undefined, config, aiService, ctx);
    expect(result).toBe(false);
    expect(classify).not.toHaveBeenCalled();
  });
});
