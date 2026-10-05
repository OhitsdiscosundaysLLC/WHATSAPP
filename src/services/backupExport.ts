import type { SupabaseClient } from '@supabase/supabase-js';
import {
  AccountSettingsRepository,
  type AccountSettingsPatch,
} from '../db/accountSettingsRepository';
import { ContactsRepository, type ContactSettingsPatch } from '../db/contactsRepository';
import { GroupsRepository, type GroupSettingsPatch } from '../db/groupsRepository';
import { PresetsRepository, type PresetSettings } from '../db/presetsRepository';
import { RulesRepository } from '../db/rulesRepository';

export const BACKUP_SCHEMA_VERSION = 1;

/**
 * Every field this backup is allowed to carry for each shape — explicit
 * positive allowlists, never a blacklist (same pattern as
 * `PRESET_SETTINGS_FIELDS` in presetsRepository.ts). `humanTakeoverUntil`
 * and `dailySummaryLastSentDate` are deliberately excluded: both are
 * transient runtime state tied to "right now", not reusable configuration
 * — restoring a stale takeover deadline or dedup date from an old backup
 * would be misleading, not helpful.
 *
 * Nothing below can ever be a WhatsApp auth credential, a Supabase service
 * role key, an OpenAI API key, the encryption key, the dashboard password,
 * or a session secret — none of those are modeled as group/contact/account
 * *settings* anywhere in this codebase, so there is no field here that
 * could carry one. `assertNoSecretLookingKeys` below is a second,
 * independent check against that same guarantee.
 */
export const BACKUP_GROUP_SETTINGS_FIELDS = [
  'botEnabled',
  'monitoringEnabled',
  'aiEnabled',
  'autoReplyEnabled',
  'deletedMessageArchiveEnabled',
  'viewOnceHandlingEnabled',
  'callHandlingEnabled',
  'moderationEnabled',
  'customGroupInstructions',
  'customAiInstructions',
  'defaultCooldownSeconds',
  'aiAutoReplyEnabled',
  'aiSemanticClassificationEnabled',
  'aiCooldownSeconds',
  'aiMaxResponsesPerHour',
  'deletedMessageRetentionDays',
  'mediaMaxFileSizeBytes',
  'moderationDestructiveActionsEnabled',
  'dryRunEnabled',
  'vip',
  'neverAutoReply',
  'neverModerate',
  'ownerNotes',
  'quietHoursEnabled',
  'quietHoursTimezone',
  'quietHoursDays',
  'quietHoursStartMinutes',
  'quietHoursEndMinutes',
  'approvalRequired',
  'mediaArchiveEnabled',
  'deletedMessageAlertMode',
] as const satisfies readonly (keyof GroupSettingsPatch)[];

export const BACKUP_CONTACT_SETTINGS_FIELDS = [
  'privateMonitoringEnabled',
  'privateAiEnabled',
  'privateAutoReplyEnabled',
  'privateAiAutoReplyEnabled',
  'privateAiSemanticClassificationEnabled',
  'privateDeletedMessageArchiveEnabled',
  'customInstructions',
  'customAiInstructions',
  'defaultCooldownSeconds',
  'aiCooldownSeconds',
  'aiMaxResponsesPerHour',
  'deletedMessageRetentionDays',
  'dryRunEnabled',
  'vip',
  'neverAutoReply',
  'neverModerate',
  'ownerNotes',
  'quietHoursEnabled',
  'quietHoursTimezone',
  'quietHoursDays',
  'quietHoursStartMinutes',
  'quietHoursEndMinutes',
  'approvalRequired',
  'mediaArchiveEnabled',
  'deletedMessageAlertMode',
] as const satisfies readonly (keyof ContactSettingsPatch)[];

export const BACKUP_ACCOUNT_SETTINGS_FIELDS = [
  'callHandlingEnabled',
  'callResponseAction',
  'callResponseMessage',
  'automationPaused',
  'dailySummaryEnabled',
  'dailySummaryTimeMinutes',
  'dailySummaryTimezone',
  'dailySummaryDelivery',
  'dailySummaryMetrics',
] as const satisfies readonly (keyof AccountSettingsPatch)[];

export interface BackupRuleEntry {
  name: string;
  triggerType: string;
  enabled: boolean;
  config: unknown;
}

export interface BackupGroupEntry {
  whatsappGroupJid: string;
  subject: string;
  settings: Pick<GroupSettingsPatch, (typeof BACKUP_GROUP_SETTINGS_FIELDS)[number]>;
  rules: BackupRuleEntry[];
}

export interface BackupContactEntry {
  whatsappJid: string;
  displayName: string | undefined;
  blocked: boolean;
  allowlisted: boolean;
  settings: Pick<ContactSettingsPatch, (typeof BACKUP_CONTACT_SETTINGS_FIELDS)[number]>;
  rules: BackupRuleEntry[];
}

export interface BackupPresetEntry {
  name: string;
  settings: PresetSettings;
}

export interface BackupDocument {
  schemaVersion: number;
  exportedAt: string;
  sourceAccountLabel: string;
  accountSettings: Pick<AccountSettingsPatch, (typeof BACKUP_ACCOUNT_SETTINGS_FIELDS)[number]>;
  groups: BackupGroupEntry[];
  contacts: BackupContactEntry[];
  presets: BackupPresetEntry[];
}

function pickAllowlist<T extends object, K extends keyof T>(
  obj: T,
  keys: readonly K[],
): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const key of keys) {
    if (Object.hasOwn(obj, key)) out[key] = obj[key];
  }
  return out;
}

const FORBIDDEN_KEY_PATTERN =
  /password|secret|token|credential|api[_-]?key|private[_-]?key|encryption[_-]?key|service[_-]?role|session/i;

/**
 * Defense in depth: even though every field above is drawn from an
 * explicit positive allowlist, walk the finished document and refuse to
 * export anything whose key merely *looks* like a secret. This guards
 * against a future field being added to one of the allowlists above
 * without this file being updated to match.
 */
export function assertNoSecretLookingKeys(value: unknown, path = '$'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretLookingKeys(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      if (FORBIDDEN_KEY_PATTERN.test(key)) {
        throw new Error(`Refusing to export a field that looks like a secret: ${path}.${key}`);
      }
      assertNoSecretLookingKeys(nested, `${path}.${key}`);
    }
  }
}

function toBackupRule(rule: {
  name: string;
  triggerType: string;
  enabled: boolean;
  config: unknown;
}): BackupRuleEntry {
  return {
    name: rule.name,
    triggerType: rule.triggerType,
    enabled: rule.enabled,
    config: rule.config,
  };
}

/**
 * Builds a complete, safe configuration backup for one WhatsApp account:
 * account-level settings, every group's settings + rules, every private
 * contact's settings + rules, and every saved automation preset. Never
 * includes WhatsApp auth state, messages, media, or any credential — those
 * live in entirely different tables that this function never touches.
 */
export async function buildBackupDocument(
  supabase: SupabaseClient,
  accountId: string,
  sourceAccountLabel: string,
): Promise<BackupDocument> {
  const groupsRepository = new GroupsRepository(supabase);
  const contactsRepository = new ContactsRepository(supabase);
  const rulesRepository = new RulesRepository(supabase);
  const presetsRepository = new PresetsRepository(supabase);
  const accountSettingsRepository = new AccountSettingsRepository(supabase);

  const [accountSettings, groups, contacts, presets] = await Promise.all([
    accountSettingsRepository.ensure(accountId),
    groupsRepository.listByAccount(accountId),
    contactsRepository.listByAccount(accountId),
    presetsRepository.listByAccount(accountId),
  ]);

  const groupEntries: BackupGroupEntry[] = await Promise.all(
    groups.map(async (group) => {
      const [settings, rules] = await Promise.all([
        groupsRepository.ensureSettings(group.id),
        rulesRepository.listByGroup(group.id),
      ]);
      return {
        whatsappGroupJid: group.whatsappGroupJid,
        subject: group.subject,
        settings: pickAllowlist(settings, BACKUP_GROUP_SETTINGS_FIELDS),
        rules: rules.map(toBackupRule),
      };
    }),
  );

  const contactEntries: BackupContactEntry[] = await Promise.all(
    contacts.map(async (contact) => {
      const [settings, rules] = await Promise.all([
        contactsRepository.ensureSettings(contact.id),
        rulesRepository.listByContact(contact.id),
      ]);
      return {
        whatsappJid: contact.whatsappJid,
        displayName: contact.displayName,
        blocked: contact.blocked,
        allowlisted: contact.allowlisted,
        settings: pickAllowlist(settings, BACKUP_CONTACT_SETTINGS_FIELDS),
        rules: rules.map(toBackupRule),
      };
    }),
  );

  const presetEntries: BackupPresetEntry[] = presets.map((preset) => ({
    name: preset.name,
    settings: preset.settings,
  }));

  const document: BackupDocument = {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    sourceAccountLabel,
    accountSettings: pickAllowlist(accountSettings, BACKUP_ACCOUNT_SETTINGS_FIELDS),
    groups: groupEntries,
    contacts: contactEntries,
    presets: presetEntries,
  };

  assertNoSecretLookingKeys(document);
  return document;
}
