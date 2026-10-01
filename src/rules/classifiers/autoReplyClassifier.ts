import type { AiCallContext, AIService } from '../../ai/aiService';
import type { AutoReplyQualifyConfig } from '../ruleConfig';
import { matchesByMode } from './responseClassifier';

/**
 * Qualifies a message against an `auto_reply` rule's `qualify` config.
 * Deterministic matching never touches the network; the AI path is only
 * ever reached by a caller (`src/rules/ruleEngine.ts`) that has already
 * confirmed every required permission gate (`ai_enabled`,
 * `auto_reply_enabled`, `ai_auto_reply_enabled`,
 * `ai_semantic_classification_enabled`, cooldown/rate limit) — this
 * function itself enforces none of that, it only classifies.
 */
export async function classifyAutoReply(
  text: string | undefined,
  config: AutoReplyQualifyConfig,
  aiService: AIService | undefined,
  ctx: AiCallContext,
): Promise<boolean> {
  if (config.classifier === 'deterministic') {
    return matchesByMode(text, config.mode, config.phrases);
  }

  // classifier === 'ai'
  if (!text) return false;
  if (!aiService) return false; // OpenAI not configured — fail closed, never silently matches.
  return aiService.classify(ctx, { criteria: config.aiInstructions, userMessage: text });
}
