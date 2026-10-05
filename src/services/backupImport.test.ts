import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { FakeSupabaseClient } from '../db/fakeSupabaseClient';
import { ContactsRepository } from '../db/contactsRepository';
import { GroupsRepository } from '../db/groupsRepository';
import { PresetsRepository } from '../db/presetsRepository';
import { RulesRepository } from '../db/rulesRepository';
import { AuditRepository } from '../db/auditRepository';
import { buildBackupDocument } from './backupExport';
import {
  applyBackupImport,
  planBackupImport,
  validateBackupDocument,
  type ValidatedBackupDocument,
} from './backupImport';

function supabaseOf(fake: FakeSupabaseClient): SupabaseClient {
  return fake as unknown as SupabaseClient;
}

const AUTO_REPLY_CONFIG = {
  qualify: { classifier: 'deterministic', mode: 'contains', phrases: ['hours'] },
  action: { type: 'SEND_MESSAGE', message: 'We are open 9-5.' },
  cooldownSeconds: 0,
};

function minimalDocument(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    sourceAccountLabel: 'Source Bot',
    accountSettings: { automationPaused: true },
    groups: [],
    contacts: [],
    presets: [],
  };
}

describe('validateBackupDocument', () => {
  it('accepts a well-formed document', () => {
    const result = validateBackupDocument(minimalDocument());
    expect(result.valid).toBe(true);
  });

  it('rejects an unsupported schema version rather than guessing', () => {
    const doc = minimalDocument();
    doc.schemaVersion = 999;
    const result = validateBackupDocument(doc);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toMatch(/schema version/i);
  });

  it('rejects a document carrying an unknown top-level field instead of silently dropping it', () => {
    const doc = minimalDocument();
    (doc as Record<string, unknown>).supabaseServiceRoleKey = 'super-secret';
    const result = validateBackupDocument(doc);
    expect(result.valid).toBe(false);
  });

  it('rejects a document whose group settings carry an unknown field', () => {
    const doc = minimalDocument();
    doc.groups = [
      {
        whatsappGroupJid: 'group@g.us',
        subject: 'Team',
        settings: { botEnabled: true, openaiApiKey: 'sk-secret' },
        rules: [],
      },
    ];
    const result = validateBackupDocument(doc);
    expect(result.valid).toBe(false);
  });

  it('rejects malformed shapes (not an object, missing fields)', () => {
    expect(validateBackupDocument(null).valid).toBe(false);
    expect(validateBackupDocument('not a document').valid).toBe(false);
    expect(validateBackupDocument({}).valid).toBe(false);
  });
});

describe('planBackupImport', () => {
  it('reports matched vs unmatched groups/contacts and rule diff counts without writing anything', async () => {
    const fake = new FakeSupabaseClient();
    const supabase = supabaseOf(fake);
    const groupsRepository = new GroupsRepository(supabase);
    const contactsRepository = new ContactsRepository(supabase);
    const presetsRepository = new PresetsRepository(supabase);

    await groupsRepository.upsertDiscoveredGroup('acct-target', 'known@g.us', 'Known Group');
    await contactsRepository.upsertDiscoveredContact(
      'acct-target',
      'known@s.whatsapp.net',
      'Known',
    );
    await presetsRepository.create('acct-target', 'Business', { botEnabled: true });

    const doc: ValidatedBackupDocument = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      sourceAccountLabel: 'Source',
      accountSettings: {},
      groups: [
        {
          whatsappGroupJid: 'known@g.us',
          subject: 'Known Group',
          settings: {},
          rules: [
            {
              name: 'New Rule',
              triggerType: 'auto_reply',
              enabled: true,
              config: AUTO_REPLY_CONFIG,
            },
          ],
        },
        { whatsappGroupJid: 'unknown@g.us', subject: 'Unknown Group', settings: {}, rules: [] },
      ],
      contacts: [
        {
          whatsappJid: 'known@s.whatsapp.net',
          blocked: false,
          allowlisted: false,
          settings: {},
          rules: [],
        },
        {
          whatsappJid: 'unknown@s.whatsapp.net',
          blocked: false,
          allowlisted: false,
          settings: {},
          rules: [],
        },
      ],
      presets: [
        { name: 'Business', settings: {} },
        { name: 'Staff', settings: {} },
      ],
    };

    const plan = await planBackupImport(supabase, 'acct-target', doc);

    expect(plan.groups).toEqual([
      expect.objectContaining({
        whatsappGroupJid: 'known@g.us',
        matched: true,
        rulesToCreate: 1,
        rulesToUpdate: 0,
      }),
      expect.objectContaining({
        whatsappGroupJid: 'unknown@g.us',
        matched: false,
        rulesToCreate: 0,
      }),
    ]);
    expect(plan.contacts).toEqual([
      expect.objectContaining({ whatsappJid: 'known@s.whatsapp.net', matched: true }),
      expect.objectContaining({ whatsappJid: 'unknown@s.whatsapp.net', matched: false }),
    ]);
    expect(plan.presets).toEqual([
      { name: 'Business', willCreate: false },
      { name: 'Staff', willCreate: true },
    ]);

    // Preview must never write — re-reading the known group's rules shows nothing was created.
    const rulesRepository = new RulesRepository(supabase);
    const existingGroup = await groupsRepository.getByJid('acct-target', 'known@g.us');
    const rules = await rulesRepository.listByGroup(existingGroup!.id);
    expect(rules).toHaveLength(0);
  });
});

describe('applyBackupImport', () => {
  it('applies settings and creates rules only on matched groups/contacts, skips unmatched, and records an audit event', async () => {
    const fake = new FakeSupabaseClient();
    const supabase = supabaseOf(fake);
    const groupsRepository = new GroupsRepository(supabase);
    const contactsRepository = new ContactsRepository(supabase);
    const rulesRepository = new RulesRepository(supabase);

    const group = await groupsRepository.upsertDiscoveredGroup(
      'acct-target',
      'known@g.us',
      'Known Group',
    );
    const contact = await contactsRepository.upsertDiscoveredContact(
      'acct-target',
      'known@s.whatsapp.net',
      'Known',
    );

    const doc: ValidatedBackupDocument = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      sourceAccountLabel: 'Source',
      accountSettings: { automationPaused: true },
      groups: [
        {
          whatsappGroupJid: 'known@g.us',
          subject: 'Known Group',
          settings: { botEnabled: true, vip: true },
          rules: [
            { name: 'Hours', triggerType: 'auto_reply', enabled: true, config: AUTO_REPLY_CONFIG },
          ],
        },
        {
          whatsappGroupJid: 'unknown@g.us',
          subject: 'Unknown Group',
          settings: { botEnabled: true },
          rules: [],
        },
      ],
      contacts: [
        {
          whatsappJid: 'known@s.whatsapp.net',
          blocked: false,
          allowlisted: false,
          settings: { vip: true },
          rules: [
            {
              name: 'DM reply',
              triggerType: 'auto_reply',
              enabled: true,
              config: AUTO_REPLY_CONFIG,
            },
          ],
        },
      ],
      presets: [{ name: 'Business', settings: { botEnabled: true } }],
    };

    const result = await applyBackupImport(supabase, 'acct-target', doc);

    expect(result).toEqual({
      groupsMatched: 1,
      groupsSkipped: 1,
      contactsMatched: 1,
      contactsSkipped: 0,
      rulesCreated: 2,
      rulesUpdated: 0,
      presetsCreated: 1,
      presetsSkipped: 0,
    });

    const settings = await groupsRepository.getSettings(group.id);
    expect(settings?.botEnabled).toBe(true);
    expect(settings?.vip).toBe(true);

    const contactSettings = await contactsRepository.getSettings(contact.id);
    expect(contactSettings?.vip).toBe(true);

    const groupRules = await rulesRepository.listByGroup(group.id);
    expect(groupRules).toHaveLength(1);
    expect(groupRules[0]?.name).toBe('Hours');

    const auditRepository = new AuditRepository(supabase);
    const recent = await auditRepository.listRecent(10);
    expect(recent.some((e) => e.eventType === 'backup.imported')).toBe(true);
  });

  it('updates an existing rule with the same name+triggerType instead of duplicating it', async () => {
    const fake = new FakeSupabaseClient();
    const supabase = supabaseOf(fake);
    const groupsRepository = new GroupsRepository(supabase);
    const rulesRepository = new RulesRepository(supabase);

    const group = await groupsRepository.upsertDiscoveredGroup(
      'acct-target',
      'known@g.us',
      'Known Group',
    );
    await rulesRepository.create({
      groupId: group.id,
      name: 'Hours',
      triggerType: 'auto_reply',
      config: AUTO_REPLY_CONFIG,
      enabled: true,
    });

    const updatedConfig = {
      ...AUTO_REPLY_CONFIG,
      action: { type: 'SEND_MESSAGE', message: 'We are open 10-6 now.' },
    };
    const doc: ValidatedBackupDocument = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      sourceAccountLabel: 'Source',
      accountSettings: {},
      groups: [
        {
          whatsappGroupJid: 'known@g.us',
          subject: 'Known Group',
          settings: {},
          rules: [
            { name: 'Hours', triggerType: 'auto_reply', enabled: false, config: updatedConfig },
          ],
        },
      ],
      contacts: [],
      presets: [],
    };

    const result = await applyBackupImport(supabase, 'acct-target', doc);
    expect(result.rulesCreated).toBe(0);
    expect(result.rulesUpdated).toBe(1);

    const rules = await rulesRepository.listByGroup(group.id);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.enabled).toBe(false);
    expect(rules[0]?.config).toEqual(updatedConfig);
  });

  it('round-trips a real export through validate -> plan -> apply onto a second account', async () => {
    const fake = new FakeSupabaseClient();
    const supabase = supabaseOf(fake);
    const groupsRepository = new GroupsRepository(supabase);
    const rulesRepository = new RulesRepository(supabase);

    const sourceGroup = await groupsRepository.upsertDiscoveredGroup(
      'acct-source',
      'shared@g.us',
      'Shared JID',
    );
    await groupsRepository.updateSettings(sourceGroup.id, {
      botEnabled: true,
      monitoringEnabled: true,
    });
    await rulesRepository.create({
      groupId: sourceGroup.id,
      name: 'Hours',
      triggerType: 'auto_reply',
      config: AUTO_REPLY_CONFIG,
    });

    const exported = await buildBackupDocument(supabase, 'acct-source', 'Source Bot');
    const roundTripped = JSON.parse(JSON.stringify(exported));
    const validation = validateBackupDocument(roundTripped);
    expect(validation.valid).toBe(true);
    if (!validation.valid) return;

    await groupsRepository.upsertDiscoveredGroup(
      'acct-target',
      'shared@g.us',
      'Shared JID (target copy)',
    );
    const plan = await planBackupImport(supabase, 'acct-target', validation.document);
    expect(plan.groups[0]?.matched).toBe(true);

    const result = await applyBackupImport(supabase, 'acct-target', validation.document);
    expect(result.groupsMatched).toBe(1);
    expect(result.rulesCreated).toBe(1);

    const targetGroup = await groupsRepository.getByJid('acct-target', 'shared@g.us');
    const targetSettings = await groupsRepository.getSettings(targetGroup!.id);
    expect(targetSettings?.botEnabled).toBe(true);
    expect(targetSettings?.monitoringEnabled).toBe(true);
  });
});
