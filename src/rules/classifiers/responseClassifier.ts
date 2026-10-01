import type { QualifyConfig } from '../ruleConfig';

/**
 * Decides whether a message qualifies as a "response" for a
 * `response_threshold` rule. Deliberately an interface with exactly one
 * method, `Promise`-returning even for a synchronous implementation, so a
 * future `AIResponseClassifier` (Phase 6 — semantic classification via
 * OpenAI) can plug in without changing the rule engine's control flow. See
 * docs/DECISIONS.md ADR-012: the rule engine must not be tightly coupled
 * to any one classification strategy.
 */
export interface ResponseClassifier {
  readonly kind: string;
  classify(text: string | undefined, config: QualifyConfig): Promise<boolean>;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Case-insensitive exact/contains/keyword matching — the one deterministic
 * matching primitive shared by `DeterministicResponseClassifier`
 * (`response_threshold` rules) and `auto_reply` rules' deterministic
 * qualify mode (`src/rules/classifiers/autoReplyClassifier.ts`), so the
 * two trigger types can't silently drift into different matching
 * semantics for what reads as the same configuration shape.
 */
export function matchesByMode(
  text: string | undefined,
  mode: 'contains' | 'exact' | 'keyword_any',
  phrases: string[],
): boolean {
  if (!text) return false;
  const normalizedText = normalize(text);
  const normalizedPhrases = phrases.map(normalize);

  switch (mode) {
    case 'exact':
      return normalizedPhrases.includes(normalizedText);
    case 'contains':
      return normalizedPhrases.some((phrase) => normalizedText.includes(phrase));
    case 'keyword_any': {
      const words = normalizedText.split(/\s+/).filter(Boolean);
      return normalizedPhrases.some((phrase) => words.includes(phrase));
    }
  }
}

/**
 * Phase 5's classifier: exact/contains/keyword matching, case-insensitive,
 * no AI involved. This is the "qualification without AI" step the product
 * spec requires before Phase 6 adds semantic classification.
 */
export class DeterministicResponseClassifier implements ResponseClassifier {
  readonly kind = 'deterministic';

  async classify(text: string | undefined, config: QualifyConfig): Promise<boolean> {
    return matchesByMode(text, config.mode, config.phrases);
  }
}
