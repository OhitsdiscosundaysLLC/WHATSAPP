import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { ModerationStateRepository } from '../../db/moderationStateRepository';
import { FakeSupabaseClient } from '../../db/fakeSupabaseClient';
import type { ModerationQualifyConfig } from '../ruleConfig';
import { qualifiesForModeration } from './moderationQualifier';

function repo(): ModerationStateRepository {
  return new ModerationStateRepository(new FakeSupabaseClient() as unknown as SupabaseClient);
}

const BASE: ModerationQualifyConfig = {
  bannedPhrases: [],
  spamRepeatThreshold: 0,
  spamWindowSeconds: 30,
  detectLinks: false,
};

describe('qualifiesForModeration', () => {
  it('matches a banned phrase, case-insensitively', async () => {
    const result = await qualifiesForModeration(
      'This contains a BAD WORD in it',
      'alice@s.whatsapp.net',
      'rule-1',
      { ...BASE, bannedPhrases: ['bad word'] },
      repo(),
    );
    expect(result.qualifies).toBe(true);
    expect(result.violationType).toBe('banned_phrase');
  });

  it('detects a link when detectLinks is on', async () => {
    const result = await qualifiesForModeration(
      'check this out https://example.com/spam',
      'alice@s.whatsapp.net',
      'rule-1',
      { ...BASE, detectLinks: true },
      repo(),
    );
    expect(result.qualifies).toBe(true);
    expect(result.violationType).toBe('link');
  });

  it('never flags a link when detectLinks is off', async () => {
    const result = await qualifiesForModeration(
      'check this out https://example.com',
      'alice@s.whatsapp.net',
      'rule-1',
      BASE,
      repo(),
    );
    expect(result.qualifies).toBe(false);
  });

  it('does not qualify a clean message', async () => {
    const result = await qualifiesForModeration(
      'hello everyone, how are you?',
      'alice@s.whatsapp.net',
      'rule-1',
      BASE,
      repo(),
    );
    expect(result.qualifies).toBe(false);
  });

  it('spam: qualifies once the sender crosses the repeat threshold within the window', async () => {
    const r = repo();
    const config = { ...BASE, spamRepeatThreshold: 3, spamWindowSeconds: 60 };
    const r1 = await qualifiesForModeration('msg1', 'spammer@s.whatsapp.net', 'rule-1', config, r);
    const r2 = await qualifiesForModeration('msg2', 'spammer@s.whatsapp.net', 'rule-1', config, r);
    const r3 = await qualifiesForModeration('msg3', 'spammer@s.whatsapp.net', 'rule-1', config, r);
    expect(r1.qualifies).toBe(false);
    expect(r2.qualifies).toBe(false);
    expect(r3.qualifies).toBe(true);
    expect(r3.violationType).toBe('spam');
  });

  it('spam counting is per-sender — a second sender starts fresh', async () => {
    const r = repo();
    const config = { ...BASE, spamRepeatThreshold: 2, spamWindowSeconds: 60 };
    await qualifiesForModeration('m1', 'alice@s.whatsapp.net', 'rule-1', config, r);
    const bobResult = await qualifiesForModeration('m1', 'bob@s.whatsapp.net', 'rule-1', config, r);
    expect(bobResult.qualifies).toBe(false);
  });

  it('spam counting is per-rule — a second rule is unaffected by the first', async () => {
    const r = repo();
    const config = { ...BASE, spamRepeatThreshold: 1, spamWindowSeconds: 60 };
    const rule1 = await qualifiesForModeration('m1', 'alice@s.whatsapp.net', 'rule-1', config, r);
    const rule2 = await qualifiesForModeration('m1', 'alice@s.whatsapp.net', 'rule-2', config, r);
    expect(rule1.qualifies).toBe(true);
    expect(rule2.qualifies).toBe(true); // both cross their own threshold=1 independently
  });

  it('spam counting resets after the window expires', async () => {
    const r = repo();
    const config = { ...BASE, spamRepeatThreshold: 2, spamWindowSeconds: 0.01 };
    await qualifiesForModeration('m1', 'alice@s.whatsapp.net', 'rule-1', config, r);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const result = await qualifiesForModeration('m2', 'alice@s.whatsapp.net', 'rule-1', config, r);
    expect(result.qualifies).toBe(false); // window reset — this is only the 1st message of a new window
  });

  it('spamRepeatThreshold=0 disables the spam heuristic entirely', async () => {
    const r = repo();
    const config = { ...BASE, spamRepeatThreshold: 0 };
    for (let i = 0; i < 10; i++) {
      const result = await qualifiesForModeration(
        `m${i}`,
        'alice@s.whatsapp.net',
        'rule-1',
        config,
        r,
      );
      expect(result.qualifies).toBe(false);
    }
  });
});
