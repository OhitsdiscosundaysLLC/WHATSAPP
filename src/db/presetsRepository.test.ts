import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { FakeSupabaseClient } from './fakeSupabaseClient';
import { PresetsRepository, sanitizePresetSettings } from './presetsRepository';

function repo(fake: FakeSupabaseClient): PresetsRepository {
  return new PresetsRepository(fake as unknown as SupabaseClient);
}

describe('PresetsRepository', () => {
  it('creates a preset and reads it back', async () => {
    const fake = new FakeSupabaseClient();
    const presets = repo(fake);

    const preset = await presets.create('acct-1', 'Business', {
      botEnabled: true,
      autoReplyEnabled: true,
      quietHoursEnabled: true,
      quietHoursTimezone: 'America/New_York',
    });

    expect(preset).toMatchObject({
      accountId: 'acct-1',
      name: 'Business',
      settings: {
        botEnabled: true,
        autoReplyEnabled: true,
        quietHoursEnabled: true,
        quietHoursTimezone: 'America/New_York',
      },
    });
    expect(await presets.getById(preset.id)).toMatchObject({ id: preset.id });
  });

  it('strips any field outside the preset allowlist (never humanTakeoverUntil/ownerNotes)', () => {
    const sanitized = sanitizePresetSettings({
      botEnabled: true,
      humanTakeoverUntil: '2026-01-01T00:00:00.000Z',
      ownerNotes: 'some private note',
      groupId: 'group-1',
    });
    expect(sanitized).toEqual({ botEnabled: true });
  });

  it('listByAccount isolates presets between accounts', async () => {
    const fake = new FakeSupabaseClient();
    const presets = repo(fake);
    await presets.create('acct-1', 'Business', { botEnabled: true });
    await presets.create('acct-2', 'Staff', { botEnabled: true });

    const acct1Presets = await presets.listByAccount('acct-1');
    expect(acct1Presets).toHaveLength(1);
    expect(acct1Presets[0]?.name).toBe('Business');
  });

  it('update() can rename and replace settings', async () => {
    const fake = new FakeSupabaseClient();
    const presets = repo(fake);
    const preset = await presets.create('acct-1', 'Business', { botEnabled: true });

    const updated = await presets.update(preset.id, {
      name: 'Business Hours',
      settings: { botEnabled: true, autoReplyEnabled: true },
    });

    expect(updated).toMatchObject({
      name: 'Business Hours',
      settings: { botEnabled: true, autoReplyEnabled: true },
    });
  });

  it('remove() deletes the preset', async () => {
    const fake = new FakeSupabaseClient();
    const presets = repo(fake);
    const preset = await presets.create('acct-1', 'Business', { botEnabled: true });

    await presets.remove(preset.id);

    expect(await presets.getById(preset.id)).toBeUndefined();
  });

  it('duplicate() creates an independent copy — editing the original never changes the copy', async () => {
    const fake = new FakeSupabaseClient();
    const presets = repo(fake);
    const original = await presets.create('acct-1', 'Business', {
      botEnabled: true,
      autoReplyEnabled: false,
    });

    const copy = await presets.duplicate(original.id, 'Business (copy)');
    expect(copy.id).not.toBe(original.id);
    expect(copy.name).toBe('Business (copy)');
    expect(copy.settings).toEqual(original.settings);

    await presets.update(original.id, { settings: { botEnabled: true, autoReplyEnabled: true } });

    const copyAfter = await presets.getById(copy.id);
    expect(copyAfter?.settings.autoReplyEnabled).toBe(false);
  });
});
