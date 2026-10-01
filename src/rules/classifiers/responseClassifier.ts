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
 * Phase 5's classifier: exact/contains/keyword matching, case-insensitive,
 * no AI involved. This is the "qualification without AI" step the product
 * spec requires before Phase 6 adds semantic classification.
 */
export class DeterministicResponseClassifier implements ResponseClassifier {
  readonly kind = 'deterministic';

  async classify(text: string | undefined, config: QualifyConfig): Promise<boolean> {
    if (!text) return false;
    const normalizedText = normalize(text);
    const phrases = config.phrases.map(normalize);

    switch (config.mode) {
      case 'exact':
        return phrases.includes(normalizedText);
      case 'contains':
        return phrases.some((phrase) => normalizedText.includes(phrase));
      case 'keyword_any': {
        const words = normalizedText.split(/\s+/).filter(Boolean);
        return phrases.some((phrase) => words.includes(phrase));
      }
    }
  }
}
