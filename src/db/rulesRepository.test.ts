import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { FakeSupabaseClient } from './fakeSupabaseClient';
import { RulesRepository } from './rulesRepository';

function repo(): RulesRepository {
  return new RulesRepository(new FakeSupabaseClient() as unknown as SupabaseClient);
}

const validConfig = {
  targetMessageMatch: 'quoted',
  qualify: { mode: 'contains', phrases: ['congrats', 'congratulations'] },
  threshold: 5,
  action: { type: 'SEND_MESSAGE', message: 'Thanks everyone!' },
  cooldownSeconds: 60,
};

describe('RulesRepository', () => {
  it('creates a rule with a valid response_threshold config', async () => {
    const r = repo();
    const rule = await r.create({
      groupId: 'group-1',
      name: 'Five people congratulate',
      triggerType: 'response_threshold',
      config: validConfig,
    });
    expect(rule.name).toBe('Five people congratulate');
    expect(rule.enabled).toBe(true);
    expect(rule.config.threshold).toBe(5);
  });

  it('rejects an unknown trigger_type', async () => {
    const r = repo();
    await expect(
      r.create({
        groupId: 'group-1',
        name: 'X',
        triggerType: 'not_a_real_type',
        config: validConfig,
      }),
    ).rejects.toThrow(/Unknown rule trigger_type/);
  });

  it('rejects a config missing required fields', async () => {
    const r = repo();
    await expect(
      r.create({
        groupId: 'group-1',
        name: 'Missing threshold',
        triggerType: 'response_threshold',
        config: { targetMessageMatch: 'quoted', qualify: { mode: 'contains', phrases: ['x'] } },
      }),
    ).rejects.toThrow(/Invalid rule config/);
  });

  it('rejects a config with the wrong types (not silently coerced)', async () => {
    const r = repo();
    await expect(
      r.create({
        groupId: 'group-1',
        name: 'Bad threshold type',
        triggerType: 'response_threshold',
        config: { ...validConfig, threshold: 'five' },
      }),
    ).rejects.toThrow(/Invalid rule config/);
  });

  it('rejects an action config naming an unsupported action type', async () => {
    const r = repo();
    await expect(
      r.create({
        groupId: 'group-1',
        name: 'Bad action',
        triggerType: 'response_threshold',
        config: { ...validConfig, action: { type: 'DELETE_EVERYTHING' } },
      }),
    ).rejects.toThrow(/Invalid rule config/);
  });

  it('enable/disable toggles only the targeted rule', async () => {
    const r = repo();
    const a = await r.create({
      groupId: 'g1',
      name: 'A',
      triggerType: 'response_threshold',
      config: validConfig,
    });
    const b = await r.create({
      groupId: 'g1',
      name: 'B',
      triggerType: 'response_threshold',
      config: validConfig,
    });

    await r.setEnabled(a.id, false);

    const refreshedA = await r.getById(a.id);
    const refreshedB = await r.getById(b.id);
    expect(refreshedA?.enabled).toBe(false);
    expect(refreshedB?.enabled).toBe(true);
  });

  it('listEnabledByGroup excludes disabled rules', async () => {
    const r = repo();
    const a = await r.create({
      groupId: 'g1',
      name: 'A',
      triggerType: 'response_threshold',
      config: validConfig,
    });
    await r.create({
      groupId: 'g1',
      name: 'B',
      triggerType: 'response_threshold',
      config: validConfig,
    });
    await r.setEnabled(a.id, false);

    const enabled = await r.listEnabledByGroup('g1');
    expect(enabled.map((x) => x.name)).toEqual(['B']);
  });

  it('remove deletes the rule', async () => {
    const r = repo();
    const a = await r.create({
      groupId: 'g1',
      name: 'A',
      triggerType: 'response_threshold',
      config: validConfig,
    });
    await r.remove(a.id);
    expect(await r.getById(a.id)).toBeUndefined();
  });

  it('update validates a replacement config before applying it', async () => {
    const r = repo();
    const a = await r.create({
      groupId: 'g1',
      name: 'A',
      triggerType: 'response_threshold',
      config: validConfig,
    });
    await expect(r.update(a.id, { config: { threshold: -1 } })).rejects.toThrow(
      /Invalid rule config/,
    );

    // The rejected update must not have partially applied.
    const unchanged = await r.getById(a.id);
    expect(unchanged?.config.threshold).toBe(5);
  });

  it('rules created for one group never appear when listing another group', async () => {
    const r = repo();
    await r.create({
      groupId: 'g1',
      name: 'G1 rule',
      triggerType: 'response_threshold',
      config: validConfig,
    });
    await r.create({
      groupId: 'g2',
      name: 'G2 rule',
      triggerType: 'response_threshold',
      config: validConfig,
    });

    const g1Rules = await r.listByGroup('g1');
    expect(g1Rules.map((x) => x.name)).toEqual(['G1 rule']);
  });
});
