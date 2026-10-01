import { describe, expect, it } from 'vitest';
import { DeterministicResponseClassifier } from './responseClassifier';

describe('DeterministicResponseClassifier', () => {
  const classifier = new DeterministicResponseClassifier();

  it('returns false for undefined text', async () => {
    expect(await classifier.classify(undefined, { mode: 'contains', phrases: ['x'] })).toBe(false);
  });

  describe('contains mode', () => {
    it('qualifies when the text contains the phrase, case-insensitively', async () => {
      expect(
        await classifier.classify('Congratulations sir!!', {
          mode: 'contains',
          phrases: ['congrat'],
        }),
      ).toBe(true);
      expect(
        await classifier.classify('CONGRATULATIONS', {
          mode: 'contains',
          phrases: ['congratulations'],
        }),
      ).toBe(true);
    });

    it('does not qualify an unrelated message', async () => {
      expect(
        await classifier.classify('What time is the meeting?', {
          mode: 'contains',
          phrases: ['congrats', 'congratulations'],
        }),
      ).toBe(false);
    });
  });

  describe('exact mode', () => {
    it('qualifies only an exact (trimmed, case-insensitive) match', async () => {
      expect(
        await classifier.classify('  Noted sir  ', { mode: 'exact', phrases: ['noted sir'] }),
      ).toBe(true);
    });

    it('does not qualify a superset of the phrase', async () => {
      expect(
        await classifier.classify('Noted sir, thanks!', { mode: 'exact', phrases: ['noted sir'] }),
      ).toBe(false);
    });
  });

  describe('keyword_any mode', () => {
    it('qualifies when any whitespace-delimited word matches a phrase exactly', async () => {
      expect(
        await classifier.classify('okay sir see you', { mode: 'keyword_any', phrases: ['okay'] }),
      ).toBe(true);
    });

    it('does not qualify a word that merely contains the keyword as a substring', async () => {
      expect(
        await classifier.classify('okayish I guess', { mode: 'keyword_any', phrases: ['okay'] }),
      ).toBe(false);
    });
  });

  it('matches any of several configured phrases (the five-person example wording)', async () => {
    const config = {
      mode: 'contains' as const,
      phrases: ['congrats', 'congratulations', 'noted sir', 'okay sir'],
    };
    expect(await classifier.classify('Congratulations sir', config)).toBe(true);
    expect(await classifier.classify('Congrats!', config)).toBe(true);
    expect(await classifier.classify('Noted sir', config)).toBe(true);
    expect(await classifier.classify('Okay sir', config)).toBe(true);
    expect(await classifier.classify('lol what', config)).toBe(false);
  });
});
