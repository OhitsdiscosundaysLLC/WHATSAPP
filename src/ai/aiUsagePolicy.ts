import type { AiUsageRepository } from '../db/aiUsageRepository';

export interface AiUsageLimits {
  aiCooldownSeconds: number;
  /** `undefined` = unlimited. */
  aiMaxResponsesPerHour: number | undefined;
}

export interface AiPermissionCheck {
  allowed: boolean;
  reason: string | undefined;
}

/**
 * The "is AI even allowed to run right now for this group" gate — separate
 * from whether a specific rule/command *wants* AI (that's `ai_enabled` +
 * the caller's own explicit-trigger check). This only answers the
 * rate-limiting question: cooldown and max-responses-per-hour, both
 * read from `whatsapp_ai_usage` (durable — survives a restart, same
 * reasoning as `rule_cooldowns`/`rule_matches`, see docs/DECISIONS.md).
 * Called by the rule engine (auto-reply) and the `.ai` command handler —
 * the one shared place this policy is enforced, so it can't drift between
 * the two call sites.
 */
export async function checkAiUsageAllowed(
  groupId: string,
  limits: AiUsageLimits,
  aiUsageRepository: AiUsageRepository,
): Promise<AiPermissionCheck> {
  if (limits.aiCooldownSeconds > 0) {
    const lastUsedAt = await aiUsageRepository.getLastSuccessfulAt(groupId);
    if (lastUsedAt) {
      const elapsedSeconds = (Date.now() - lastUsedAt.getTime()) / 1000;
      if (elapsedSeconds < limits.aiCooldownSeconds) {
        return {
          allowed: false,
          reason: `AI cooldown active (${Math.ceil(limits.aiCooldownSeconds - elapsedSeconds)}s remaining)`,
        };
      }
    }
  }

  if (limits.aiMaxResponsesPerHour !== undefined) {
    const sinceOneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const count = await aiUsageRepository.countRecentSuccessful(groupId, sinceOneHourAgo);
    if (count >= limits.aiMaxResponsesPerHour) {
      return {
        allowed: false,
        reason: `AI max responses per hour reached (${count}/${limits.aiMaxResponsesPerHour})`,
      };
    }
  }

  return { allowed: true, reason: undefined };
}
