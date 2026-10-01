import { z } from 'zod';

/**
 * Every rule's `config` column is `jsonb` at the schema level (see the
 * migration), but nothing in this codebase ever treats that JSON as
 * executable without first validating it against one of these schemas,
 * keyed on `trigger_type`. An unvalidated/malformed config is a rejected
 * write or a skipped evaluation — never a crash, and never arbitrary code
 * execution.
 *
 * `response_threshold` is the only trigger type implemented in Phase 5 —
 * see the "five distinct people respond" example from the product spec.
 * The schema is deliberately extensible (new trigger types add new zod
 * schemas and extend `RuleConfigSchema`'s union) without touching the rule
 * engine's own control flow.
 */
export const QualifyConfigSchema = z.object({
  /**
   * 'contains': text includes the phrase anywhere (case-insensitive).
   * 'exact': text, trimmed, equals the phrase exactly (case-insensitive).
   * 'keyword_any': any whitespace-delimited word in the text matches a
   * phrase exactly (case-insensitive) — stricter than 'contains', looser
   * than 'exact'.
   */
  mode: z.enum(['contains', 'exact', 'keyword_any']),
  /** Case-insensitive; matched against after trimming. At least one required. */
  phrases: z.array(z.string().trim().min(1)).min(1).max(50),
});
export type QualifyConfig = z.infer<typeof QualifyConfigSchema>;

export const ActionConfigSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('SEND_MESSAGE'), message: z.string().trim().min(1).max(4096) }),
  z.object({ type: z.literal('NOTIFY_OWNER'), message: z.string().trim().min(1).max(4096) }),
  z.object({ type: z.literal('LOG_ONLY') }),
]);
export type ActionConfig = z.infer<typeof ActionConfigSchema>;

export const ResponseThresholdConfigSchema = z.object({
  /**
   * How the "target message" is identified. 'quoted' is the only mode
   * implemented: a qualifying response must be a reply/quote of the
   * announcement — see docs/DECISIONS.md ADR-012 and product spec #12.
   */
  targetMessageMatch: z.literal('quoted'),
  qualify: QualifyConfigSchema,
  /** Number of DISTINCT qualifying senders required to fire. */
  threshold: z.number().int().min(1).max(10_000),
  action: ActionConfigSchema,
  /** Minimum seconds between this rule firing again. 0 = no cooldown. */
  cooldownSeconds: z.number().int().min(0).max(86_400).default(0),
});
export type ResponseThresholdConfig = z.infer<typeof ResponseThresholdConfigSchema>;

export const TRIGGER_TYPES = ['response_threshold'] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

const SCHEMAS_BY_TRIGGER_TYPE: Record<TriggerType, z.ZodType> = {
  response_threshold: ResponseThresholdConfigSchema,
};

/**
 * Validates a rule's `config` against the schema for its `trigger_type`.
 * Throws a descriptive error (never silently coerces) on anything invalid
 * — this is the one gate every write and every execution path must pass
 * through. See src/db/rulesRepository.ts and src/rules/ruleEngine.ts.
 */
export function validateRuleConfig(triggerType: string, config: unknown): ResponseThresholdConfig {
  const schema = SCHEMAS_BY_TRIGGER_TYPE[triggerType as TriggerType];
  if (!schema) {
    throw new Error(
      `Unknown rule trigger_type "${triggerType}" — must be one of: ${TRIGGER_TYPES.join(', ')}`,
    );
  }
  const result = schema.safeParse(config);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid rule config for trigger_type "${triggerType}": ${issues}`);
  }
  return result.data as ResponseThresholdConfig;
}
