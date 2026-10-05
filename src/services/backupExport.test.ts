import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { FakeSupabaseClient } from '../db/fakeSupabaseClient';
import { ContactsRepository } from '../db/contactsRepository';
import { GroupsRepository } from '../db/groupsRepository';
import { PresetsRepository } from '../db/presetsRepository';
import { RulesRepository } from '../db/rulesRepository';
import { AccountSettingsRepository } from '../db/accountSettingsRepository';
import {
  assertNoSecretLookingKeys,
  BACKUP_SCHEMA_VERSION,
  buildBackupDocument,
} from './backupExport';

function supabaseOf(fake: FakeSupabaseClient): SupabaseClient {
  return fake as unknown as SupabaseClient;
}

const AUTO_REPLY_CONFIG = {
  qualify: { classifier: 'deterministic', mode: 'contains', phrases: ['hours'] },
  action: { type: 'SEND_MESSAGE', message: 'We are open 9-5.' },
  cooldownSeconds: 0,
};

describe('buildBackupDocument', () => {
  it('captures account settings, group settings + rules, contact settings + rules, and presets', async () => {
    const fake = new FakeSupabaseClient();
    const supabase = supabaseOf(fake);
    const groupsRepository = new GroupsRepository(supabase);
    const contactsRepository = new ContactsRepository(supabase);
    const rulesRepository = new RulesRepository(supabase);
    const presetsRepository = new PresetsRepository(supabase);
    const accountSettingsRepository = new AccountSettingsRepository(supabase);

    const group = await groupsRepository.upsertDiscoveredGroup('acct-1', 'group@g.us', 'Team Chat');
    await groupsRepository.updateSettings(group.id, { botEnabled: true, vip: true });
    await rulesRepository.create({
      groupId: group.id,
      name: 'Business hours',
      triggerType: 'auto_reply',
      config: AUTO_REPLY_CONFIG,
    });

    const contact = await contactsRepository.upsertDiscoveredContact(
      'acct-1',
      'a@s.whatsapp.net',
      'Alice',
    );
    await contactsRepository.updateSettings(contact.id, {
      vip: true,
      ownerNotes: 'Important client',
    });
    await rulesRepository.createForContact({
      contactId: contact.id,
      name: 'DM auto reply',
      triggerType: 'auto_reply',
      config: AUTO_REPLY_CONFIG,
    });

    await presetsRepository.create('acct-1', 'Business', {
      botEnabled: true,
      monitoringEnabled: true,
    });
    await accountSettingsRepository.update('acct-1', { automationPaused: true });

    const document = await buildBackupDocument(supabase, 'acct-1', 'My WhatsApp Bot');

    expect(document.schemaVersion).toBe(BACKUP_SCHEMA_VERSION);
    expect(document.sourceAccountLabel).toBe('My WhatsApp Bot');
    expect(document.accountSettings.automationPaused).toBe(true);

    expect(document.groups).toEqual([
      expect.objectContaining({
        whatsappGroupJid: 'group@g.us',
        subject: 'Team Chat',
        settings: expect.objectContaining({ botEnabled: true, vip: true }),
        rules: [
          expect.objectContaining({
            name: 'Business hours',
            triggerType: 'auto_reply',
            enabled: true,
            config: AUTO_REPLY_CONFIG,
          }),
        ],
      }),
    ]);

    expect(document.contacts).toEqual([
      expect.objectContaining({
        whatsappJid: 'a@s.whatsapp.net',
        displayName: 'Alice',
        settings: expect.objectContaining({ vip: true, ownerNotes: 'Important client' }),
        rules: [expect.objectContaining({ name: 'DM auto reply', triggerType: 'auto_reply' })],
      }),
    ]);

    expect(document.presets).toEqual([
      { name: 'Business', settings: { botEnabled: true, monitoringEnabled: true } },
    ]);
  });

  it('never carries a transient humanTakeoverUntil deadline or dailySummaryLastSentDate', async () => {
    const fake = new FakeSupabaseClient();
    const supabase = supabaseOf(fake);
    const groupsRepository = new GroupsRepository(supabase);
    const group = await groupsRepository.upsertDiscoveredGroup('acct-1', 'group@g.us', 'Team Chat');
    await groupsRepository.updateSettings(group.id, {
      humanTakeoverUntil: new Date(Date.now() + 60_000).toISOString(),
    });

    const document = await buildBackupDocument(supabase, 'acct-1', 'My Bot');
    expect(document.groups[0]?.settings).not.toHaveProperty('humanTakeoverUntil');
    expect(document.accountSettings).not.toHaveProperty('dailySummaryLastSentDate');
  });

  it('is a plain, downloadable JSON document with no secret-looking field anywhere', async () => {
    const fake = new FakeSupabaseClient();
    const supabase = supabaseOf(fake);
    const groupsRepository = new GroupsRepository(supabase);
    await groupsRepository.upsertDiscoveredGroup('acct-1', 'group@g.us', 'Team Chat');

    const document = await buildBackupDocument(supabase, 'acct-1', 'My Bot');
    const roundTripped = JSON.parse(JSON.stringify(document));
    expect(roundTripped).toEqual(document);
    expect(() => assertNoSecretLookingKeys(roundTripped)).not.toThrow();
  });
});

describe('assertNoSecretLookingKeys', () => {
  it('throws if a field anywhere in the tree looks like a credential', () => {
    expect(() => assertNoSecretLookingKeys({ ok: true, nested: { apiKey: 'x' } })).toThrow(
      /secret/,
    );
    expect(() => assertNoSecretLookingKeys({ supabaseServiceRole: 'x' })).toThrow();
    expect(() => assertNoSecretLookingKeys({ dashboardPassword: 'x' })).toThrow();
    expect(() => assertNoSecretLookingKeys([{ sessionToken: 'x' }])).toThrow();
  });

  it('passes for an ordinary settings-shaped object', () => {
    expect(() =>
      assertNoSecretLookingKeys({
        botEnabled: true,
        quietHoursDays: [1, 2],
        nested: { vip: true },
      }),
    ).not.toThrow();
  });
});
