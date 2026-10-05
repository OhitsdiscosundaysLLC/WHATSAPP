import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { AccountSettingsRepository } from '../db/accountSettingsRepository';
import { ContactsRepository } from '../db/contactsRepository';
import { GroupsRepository } from '../db/groupsRepository';
import { PresetsRepository, sanitizePresetSettings } from '../db/presetsRepository';
import { RulesRepository, type GroupRule } from '../db/rulesRepository';
import { AuditRepository } from '../db/auditRepository';
import { BACKUP_SCHEMA_VERSION, type BackupRuleEntry } from './backupExport';

const DeletedMessageAlertModeSchema = z.enum(['archive_only', 'dashboard', 'whatsapp', 'both']);

const GroupSettingsBackupSchema = z
  .object({
    botEnabled: z.boolean().optional(),
    monitoringEnabled: z.boolean().optional(),
    aiEnabled: z.boolean().optional(),
    autoReplyEnabled: z.boolean().optional(),
    deletedMessageArchiveEnabled: z.boolean().optional(),
    viewOnceHandlingEnabled: z.boolean().optional(),
    callHandlingEnabled: z.boolean().optional(),
    moderationEnabled: z.boolean().optional(),
    customGroupInstructions: z.string().optional(),
    customAiInstructions: z.string().optional(),
    defaultCooldownSeconds: z.number().optional(),
    aiAutoReplyEnabled: z.boolean().optional(),
    aiSemanticClassificationEnabled: z.boolean().optional(),
    aiCooldownSeconds: z.number().optional(),
    aiMaxResponsesPerHour: z.number().optional(),
    deletedMessageRetentionDays: z.number().optional(),
    mediaMaxFileSizeBytes: z.number().optional(),
    moderationDestructiveActionsEnabled: z.boolean().optional(),
    dryRunEnabled: z.boolean().optional(),
    vip: z.boolean().optional(),
    neverAutoReply: z.boolean().optional(),
    neverModerate: z.boolean().optional(),
    ownerNotes: z.string().optional(),
    quietHoursEnabled: z.boolean().optional(),
    quietHoursTimezone: z.string().optional(),
    quietHoursDays: z.array(z.number()).optional(),
    quietHoursStartMinutes: z.number().optional(),
    quietHoursEndMinutes: z.number().optional(),
    approvalRequired: z.boolean().optional(),
    mediaArchiveEnabled: z.boolean().optional(),
    deletedMessageAlertMode: DeletedMessageAlertModeSchema.optional(),
  })
  .strict();

const ContactSettingsBackupSchema = z
  .object({
    privateMonitoringEnabled: z.boolean().optional(),
    privateAiEnabled: z.boolean().optional(),
    privateAutoReplyEnabled: z.boolean().optional(),
    privateAiAutoReplyEnabled: z.boolean().optional(),
    privateAiSemanticClassificationEnabled: z.boolean().optional(),
    privateDeletedMessageArchiveEnabled: z.boolean().optional(),
    customInstructions: z.string().optional(),
    customAiInstructions: z.string().optional(),
    defaultCooldownSeconds: z.number().optional(),
    aiCooldownSeconds: z.number().optional(),
    aiMaxResponsesPerHour: z.number().optional(),
    deletedMessageRetentionDays: z.number().optional(),
    dryRunEnabled: z.boolean().optional(),
    vip: z.boolean().optional(),
    neverAutoReply: z.boolean().optional(),
    neverModerate: z.boolean().optional(),
    ownerNotes: z.string().optional(),
    quietHoursEnabled: z.boolean().optional(),
    quietHoursTimezone: z.string().optional(),
    quietHoursDays: z.array(z.number()).optional(),
    quietHoursStartMinutes: z.number().optional(),
    quietHoursEndMinutes: z.number().optional(),
    approvalRequired: z.boolean().optional(),
    mediaArchiveEnabled: z.boolean().optional(),
    deletedMessageAlertMode: DeletedMessageAlertModeSchema.optional(),
  })
  .strict();

const AccountSettingsBackupSchema = z
  .object({
    callHandlingEnabled: z.boolean().optional(),
    callResponseAction: z
      .enum(['LOG_ONLY', 'NOTIFY_OWNER', 'AUTO_REJECT', 'SEND_MESSAGE_AFTER'])
      .optional(),
    callResponseMessage: z.string().optional(),
    automationPaused: z.boolean().optional(),
    dailySummaryEnabled: z.boolean().optional(),
    dailySummaryTimeMinutes: z.number().optional(),
    dailySummaryTimezone: z.string().optional(),
    dailySummaryDelivery: z.enum(['dashboard', 'whatsapp', 'both']).optional(),
    dailySummaryMetrics: z.array(z.string()).optional(),
  })
  .strict();

/** `config` is re-validated against its own `triggerType` schema by RulesRepository at write time — never trusted here. */
const RuleEntrySchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    triggerType: z.string().min(1),
    enabled: z.boolean(),
    config: z.unknown(),
  })
  .strict();

const GroupEntrySchema = z
  .object({
    whatsappGroupJid: z.string().min(1),
    subject: z.string(),
    settings: GroupSettingsBackupSchema,
    rules: z.array(RuleEntrySchema),
  })
  .strict();

const ContactEntrySchema = z
  .object({
    whatsappJid: z.string().min(1),
    displayName: z.string().optional(),
    blocked: z.boolean(),
    allowlisted: z.boolean(),
    settings: ContactSettingsBackupSchema,
    rules: z.array(RuleEntrySchema),
  })
  .strict();

const PresetEntrySchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    settings: z.record(z.string(), z.unknown()),
  })
  .strict();

/**
 * The full shape a valid backup document must match. `.strict()` on every
 * level means an unknown field anywhere — including one named to look like
 * a credential — fails validation outright rather than being silently
 * dropped or passed through: "prevent secrets" is enforced by rejecting
 * the whole import, not by best-effort stripping.
 */
export const BackupDocumentSchema = z
  .object({
    schemaVersion: z.number(),
    exportedAt: z.string(),
    sourceAccountLabel: z.string(),
    accountSettings: AccountSettingsBackupSchema,
    groups: z.array(GroupEntrySchema),
    contacts: z.array(ContactEntrySchema),
    presets: z.array(PresetEntrySchema),
  })
  .strict();

export type ValidatedBackupDocument = z.infer<typeof BackupDocumentSchema>;

export interface BackupValidationError {
  valid: false;
  error: string;
}

export type BackupValidationResult =
  { valid: true; document: ValidatedBackupDocument } | BackupValidationError;

/** Validates shape AND schema version — a document from a future/incompatible export is rejected, never guessed at. */
export function validateBackupDocument(raw: unknown): BackupValidationResult {
  const parsed = BackupDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    return { valid: false, error: parsed.error.issues[0]?.message ?? 'Invalid backup document.' };
  }
  if (parsed.data.schemaVersion !== BACKUP_SCHEMA_VERSION) {
    return {
      valid: false,
      error: `Unsupported backup schema version ${parsed.data.schemaVersion} (expected ${BACKUP_SCHEMA_VERSION}).`,
    };
  }
  return { valid: true, document: parsed.data };
}

/**
 * Every field coming out of a zod `.optional()` schema is typed
 * `X | undefined`, which — under `exactOptionalPropertyTypes` — is not
 * assignable to this codebase's patch interfaces (`field?: X`, never
 * `field?: X | undefined`). This drops any key whose value is literally
 * `undefined` and re-types the result as plain-optional, matching the
 * `Object.hasOwn`-based patch builders elsewhere in src/db/.
 */
function toPatch<T extends object>(obj: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) out[key] = value;
  }
  return out as { [K in keyof T]?: Exclude<T[K], undefined> };
}

function ruleMatchKey(name: string, triggerType: string): string {
  return `${name}::${triggerType}`;
}

function diffRules(
  existingRules: GroupRule[],
  backupRules: BackupRuleEntry[],
): { toCreate: BackupRuleEntry[]; toUpdate: Array<{ ruleId: string; entry: BackupRuleEntry }> } {
  const existingByKey = new Map(existingRules.map((r) => [ruleMatchKey(r.name, r.triggerType), r]));
  const toCreate: BackupRuleEntry[] = [];
  const toUpdate: Array<{ ruleId: string; entry: BackupRuleEntry }> = [];
  for (const entry of backupRules) {
    const existing = existingByKey.get(ruleMatchKey(entry.name, entry.triggerType));
    if (existing) {
      toUpdate.push({ ruleId: existing.id, entry });
    } else {
      toCreate.push(entry);
    }
  }
  return { toCreate, toUpdate };
}

export interface BackupImportGroupPlan {
  whatsappGroupJid: string;
  subject: string;
  matched: boolean;
  matchedGroupId: string | undefined;
  matchedSubject: string | undefined;
  rulesToCreate: number;
  rulesToUpdate: number;
}

export interface BackupImportContactPlan {
  whatsappJid: string;
  displayName: string | undefined;
  matched: boolean;
  matchedContactId: string | undefined;
  rulesToCreate: number;
  rulesToUpdate: number;
}

export interface BackupImportPresetPlan {
  name: string;
  willCreate: boolean;
}

export interface BackupImportPlan {
  targetAccountId: string;
  sourceAccountLabel: string;
  groups: BackupImportGroupPlan[];
  contacts: BackupImportContactPlan[];
  presets: BackupImportPresetPlan[];
}

/**
 * Read-only preview: matches each backup entry against what already
 * exists on the target account and reports exactly what an apply would do
 * — without writing anything. A group/contact only in the backup (not yet
 * discovered on the target account, e.g. a different WhatsApp number) is
 * reported as unmatched and will be skipped by apply, never fabricated.
 */
export async function planBackupImport(
  supabase: SupabaseClient,
  targetAccountId: string,
  document: ValidatedBackupDocument,
): Promise<BackupImportPlan> {
  const groupsRepository = new GroupsRepository(supabase);
  const contactsRepository = new ContactsRepository(supabase);
  const rulesRepository = new RulesRepository(supabase);
  const presetsRepository = new PresetsRepository(supabase);

  const existingPresets = await presetsRepository.listByAccount(targetAccountId);
  const existingPresetNames = new Set(existingPresets.map((p) => p.name));

  const groups: BackupImportGroupPlan[] = await Promise.all(
    document.groups.map(async (entry) => {
      const match = await groupsRepository.getByJid(targetAccountId, entry.whatsappGroupJid);
      const existingRules = match ? await rulesRepository.listByGroup(match.id) : [];
      const { toCreate, toUpdate } = diffRules(existingRules, entry.rules);
      return {
        whatsappGroupJid: entry.whatsappGroupJid,
        subject: entry.subject,
        matched: Boolean(match),
        matchedGroupId: match?.id,
        matchedSubject: match?.subject,
        rulesToCreate: match ? toCreate.length : 0,
        rulesToUpdate: match ? toUpdate.length : 0,
      };
    }),
  );

  const contacts: BackupImportContactPlan[] = await Promise.all(
    document.contacts.map(async (entry) => {
      const match = await contactsRepository.getByJid(targetAccountId, entry.whatsappJid);
      const existingRules = match ? await rulesRepository.listByContact(match.id) : [];
      const { toCreate, toUpdate } = diffRules(existingRules, entry.rules);
      return {
        whatsappJid: entry.whatsappJid,
        displayName: entry.displayName,
        matched: Boolean(match),
        matchedContactId: match?.id,
        rulesToCreate: match ? toCreate.length : 0,
        rulesToUpdate: match ? toUpdate.length : 0,
      };
    }),
  );

  const presets: BackupImportPresetPlan[] = document.presets.map((entry) => ({
    name: entry.name,
    willCreate: !existingPresetNames.has(entry.name),
  }));

  return {
    targetAccountId,
    sourceAccountLabel: document.sourceAccountLabel,
    groups,
    contacts,
    presets,
  };
}

export interface BackupImportResult {
  groupsMatched: number;
  groupsSkipped: number;
  contactsMatched: number;
  contactsSkipped: number;
  rulesCreated: number;
  rulesUpdated: number;
  presetsCreated: number;
  presetsSkipped: number;
}

/**
 * Applies a validated backup to `targetAccountId`. Only ever writes
 * settings/rules/presets — never recreates a missing group or contact
 * (those must already exist from real WhatsApp discovery) and never
 * touches auth, messages, or media. Every apply is recorded as an audit
 * event, same as every other owner-triggered mutation in this codebase.
 */
export async function applyBackupImport(
  supabase: SupabaseClient,
  targetAccountId: string,
  document: ValidatedBackupDocument,
): Promise<BackupImportResult> {
  const groupsRepository = new GroupsRepository(supabase);
  const contactsRepository = new ContactsRepository(supabase);
  const rulesRepository = new RulesRepository(supabase);
  const presetsRepository = new PresetsRepository(supabase);
  const accountSettingsRepository = new AccountSettingsRepository(supabase);
  const auditRepository = new AuditRepository(supabase);

  await accountSettingsRepository.update(targetAccountId, toPatch(document.accountSettings));

  const result: BackupImportResult = {
    groupsMatched: 0,
    groupsSkipped: 0,
    contactsMatched: 0,
    contactsSkipped: 0,
    rulesCreated: 0,
    rulesUpdated: 0,
    presetsCreated: 0,
    presetsSkipped: 0,
  };

  for (const entry of document.groups) {
    const match = await groupsRepository.getByJid(targetAccountId, entry.whatsappGroupJid);
    if (!match) {
      result.groupsSkipped += 1;
      continue;
    }
    result.groupsMatched += 1;
    await groupsRepository.updateSettings(match.id, toPatch(entry.settings));

    const existingRules = await rulesRepository.listByGroup(match.id);
    const { toCreate, toUpdate } = diffRules(existingRules, entry.rules);
    for (const ruleEntry of toCreate) {
      await rulesRepository.create({
        groupId: match.id,
        name: ruleEntry.name,
        triggerType: ruleEntry.triggerType,
        config: ruleEntry.config,
        enabled: ruleEntry.enabled,
      });
      result.rulesCreated += 1;
    }
    for (const { ruleId, entry: ruleEntry } of toUpdate) {
      await rulesRepository.update(ruleId, {
        config: ruleEntry.config,
        enabled: ruleEntry.enabled,
      });
      result.rulesUpdated += 1;
    }
  }

  for (const entry of document.contacts) {
    const match = await contactsRepository.getByJid(targetAccountId, entry.whatsappJid);
    if (!match) {
      result.contactsSkipped += 1;
      continue;
    }
    result.contactsMatched += 1;
    await contactsRepository.updateSettings(match.id, toPatch(entry.settings));

    const existingRules = await rulesRepository.listByContact(match.id);
    const { toCreate, toUpdate } = diffRules(existingRules, entry.rules);
    for (const ruleEntry of toCreate) {
      if (ruleEntry.triggerType !== 'auto_reply' && ruleEntry.triggerType !== 'escalation') {
        continue;
      }
      await rulesRepository.createForContact({
        contactId: match.id,
        name: ruleEntry.name,
        triggerType: ruleEntry.triggerType,
        config: ruleEntry.config,
        enabled: ruleEntry.enabled,
      });
      result.rulesCreated += 1;
    }
    for (const { ruleId, entry: ruleEntry } of toUpdate) {
      await rulesRepository.update(ruleId, {
        config: ruleEntry.config,
        enabled: ruleEntry.enabled,
      });
      result.rulesUpdated += 1;
    }
  }

  const existingPresets = await presetsRepository.listByAccount(targetAccountId);
  const existingPresetNames = new Set(existingPresets.map((p) => p.name));
  for (const entry of document.presets) {
    if (existingPresetNames.has(entry.name)) {
      result.presetsSkipped += 1;
      continue;
    }
    await presetsRepository.create(
      targetAccountId,
      entry.name,
      sanitizePresetSettings(entry.settings),
    );
    result.presetsCreated += 1;
  }

  await auditRepository.recordEvent({
    accountId: targetAccountId,
    groupId: undefined,
    actor: 'owner',
    eventType: 'backup.imported',
    detail: { sourceAccountLabel: document.sourceAccountLabel, ...result },
  });

  return result;
}
