import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { FakeSupabaseClient } from './fakeSupabaseClient';
import { RuleStateRepository } from './ruleStateRepository';

function withFake(): { repo: RuleStateRepository; fake: FakeSupabaseClient } {
  const fake = new FakeSupabaseClient();
  fake.defineUniqueConstraint('rule_match_responders', ['rule_match_id', 'sender_jid']);
  return { repo: new RuleStateRepository(fake as unknown as SupabaseClient), fake };
}

describe('RuleStateRepository', () => {
  it('getOrCreateMatch creates once and returns the same row on repeat calls', async () => {
    const { repo } = withFake();
    const a = await repo.getOrCreateMatch('rule-1', 'TARGET_MSG');
    const b = await repo.getOrCreateMatch('rule-1', 'TARGET_MSG');
    expect(a.id).toBe(b.id);
    expect(a.fired).toBe(false);
  });

  it('a different target message gets a separate match — responses to unrelated messages never share a counter', async () => {
    const { repo } = withFake();
    const a = await repo.getOrCreateMatch('rule-1', 'ANNOUNCEMENT_A');
    const b = await repo.getOrCreateMatch('rule-1', 'ANNOUNCEMENT_B');
    expect(a.id).not.toBe(b.id);
  });

  it('counts only DISTINCT senders — five responses from one person is not five people', async () => {
    const { repo } = withFake();
    const match = await repo.getOrCreateMatch('rule-1', 'TARGET');
    for (let i = 0; i < 5; i++) {
      await repo.addResponder(match.id, 'same-sender@s.whatsapp.net', `MSG${i}`);
    }
    expect(await repo.countDistinctResponders(match.id)).toBe(1);
  });

  it('counts five distinct senders as five', async () => {
    const { repo } = withFake();
    const match = await repo.getOrCreateMatch('rule-1', 'TARGET');
    for (let i = 0; i < 5; i++) {
      await repo.addResponder(match.id, `sender-${i}@s.whatsapp.net`, `MSG${i}`);
    }
    expect(await repo.countDistinctResponders(match.id)).toBe(5);
  });

  it('tryMarkFired returns true exactly once — the second caller loses the race', async () => {
    const { repo } = withFake();
    const match = await repo.getOrCreateMatch('rule-1', 'TARGET');
    const first = await repo.tryMarkFired(match.id);
    const second = await repo.tryMarkFired(match.id);
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it('two concurrent tryMarkFired calls (Promise.all, not sequential) still let exactly one win', async () => {
    const { repo } = withFake();
    const match = await repo.getOrCreateMatch('rule-1', 'TARGET');
    const [a, b] = await Promise.all([repo.tryMarkFired(match.id), repo.tryMarkFired(match.id)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it('cooldown: no last-fired record means no cooldown is active', async () => {
    const { repo } = withFake();
    expect(await repo.getLastFiredAt('rule-1')).toBeUndefined();
  });

  it('cooldown: recordFired persists the timestamp for later cooldown checks', async () => {
    const { repo } = withFake();
    const firedAt = new Date('2026-01-01T00:00:00.000Z');
    await repo.recordFired('rule-1', firedAt);
    expect(await repo.getLastFiredAt('rule-1')).toEqual(firedAt);
  });

  it(
    'RESTART SIMULATION: threshold progress survives a process restart — 3 of 5 ' +
      'responders recorded, a brand-new repository instance (sharing only the ' +
      'database, not memory) sees the same progress and the 4th/5th responses ' +
      'complete the threshold',
    async () => {
      const fake = new FakeSupabaseClient();
      fake.defineUniqueConstraint('rule_match_responders', ['rule_match_id', 'sender_jid']);

      // ---- PROCESS A ----
      let processA: RuleStateRepository | undefined = new RuleStateRepository(
        fake as unknown as SupabaseClient,
      );
      const matchA = await processA.getOrCreateMatch('rule-1', 'ANNOUNCEMENT');
      await processA.addResponder(matchA.id, 'alice@s.whatsapp.net', 'M1');
      await processA.addResponder(matchA.id, 'bob@s.whatsapp.net', 'M2');
      await processA.addResponder(matchA.id, 'carol@s.whatsapp.net', 'M3');
      expect(await processA.countDistinctResponders(matchA.id)).toBe(3);

      // Simulate the process dying — drop every reference to PROCESS A.
      processA = undefined;

      // ---- PROCESS B: independently constructed, shares only `fake` (the DB) ----
      const processB = new RuleStateRepository(fake as unknown as SupabaseClient);
      const matchB = await processB.getOrCreateMatch('rule-1', 'ANNOUNCEMENT');
      expect(matchB.id).toBe(matchA.id);
      expect(await processB.countDistinctResponders(matchB.id)).toBe(3);

      await processB.addResponder(matchB.id, 'dave@s.whatsapp.net', 'M4');
      await processB.addResponder(matchB.id, 'erin@s.whatsapp.net', 'M5');
      expect(await processB.countDistinctResponders(matchB.id)).toBe(5);

      const won = await processB.tryMarkFired(matchB.id);
      expect(won).toBe(true);
    },
  );

  it('rule_match_responders enforces distinctness even across two repository instances racing', async () => {
    const fake = new FakeSupabaseClient();
    fake.defineUniqueConstraint('rule_match_responders', ['rule_match_id', 'sender_jid']);
    const repoA = new RuleStateRepository(fake as unknown as SupabaseClient);
    const repoB = new RuleStateRepository(fake as unknown as SupabaseClient);

    const match = await repoA.getOrCreateMatch('rule-1', 'TARGET');
    await repoA.addResponder(match.id, 'same@s.whatsapp.net', 'M1');
    await repoB.addResponder(match.id, 'same@s.whatsapp.net', 'M2');

    expect(await repoA.countDistinctResponders(match.id)).toBe(1);
  });
});
