import type { ModerationStateRepository } from '../../db/moderationStateRepository';
import type { ModerationQualifyConfig } from '../ruleConfig';

const LINK_PATTERN = /https?:\/\/\S+|\bwww\.\S+/i;

export type ModerationViolationType = 'banned_phrase' | 'spam' | 'link';

export interface ModerationQualifyResult {
  qualifies: boolean;
  violationType: ModerationViolationType | undefined;
  matchedText: string | undefined;
}

/**
 * Deterministic-only moderation qualification (product spec Part G: "start
 * with deterministic moderation"). Checks, in order, banned phrases, link
 * detection, then the repeated-message spam heuristic (the only one that
 * needs durable state, via `ModerationStateRepository` — see
 * docs/DATABASE.md's `whatsapp_moderation_state`). Returns on the first
 * match rather than evaluating all three, since only one action fires per
 * message.
 */
export async function qualifiesForModeration(
  text: string | undefined,
  senderJid: string,
  ruleId: string,
  config: ModerationQualifyConfig,
  moderationStateRepository: ModerationStateRepository,
): Promise<ModerationQualifyResult> {
  if (text) {
    const normalizedText = text.trim().toLowerCase();

    for (const phrase of config.bannedPhrases) {
      if (normalizedText.includes(phrase.trim().toLowerCase())) {
        return { qualifies: true, violationType: 'banned_phrase', matchedText: phrase };
      }
    }

    if (config.detectLinks && LINK_PATTERN.test(text)) {
      return { qualifies: true, violationType: 'link', matchedText: text.match(LINK_PATTERN)?.[0] };
    }
  }

  if (config.spamRepeatThreshold > 0) {
    const count = await moderationStateRepository.recordAndCount(
      ruleId,
      senderJid,
      config.spamWindowSeconds,
    );
    if (count >= config.spamRepeatThreshold) {
      return { qualifies: true, violationType: 'spam', matchedText: undefined };
    }
  }

  return { qualifies: false, violationType: undefined, matchedText: undefined };
}
