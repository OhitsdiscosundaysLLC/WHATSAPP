import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DeletedMessageAlertMode, GroupSettingsPatch } from './groupsRepository';

/**
 * The subset of `GroupSettingsPatch` that makes sense as a reusable,
 * named bundle (e.g. "Business", "Staff", "Community", "Client", "AI
 * Assistant"). Deliberately excludes `humanTakeoverUntil` (a specific
 * future timestamp — never a sensible default to copy onto another group)
 * and `ownerNotes` (free text about one specific group/conversation, not a
 * reusable trait).
 */
export interface PresetSettings {
  botEnabled?: boolean;
  monitoringEnabled?: boolean;
  aiEnabled?: boolean;
  autoReplyEnabled?: boolean;
  deletedMessageArchiveEnabled?: boolean;
  viewOnceHandlingEnabled?: boolean;
  callHandlingEnabled?: boolean;
  moderationEnabled?: boolean;
  customGroupInstructions?: string | undefined;
  customAiInstructions?: string | undefined;
  defaultCooldownSeconds?: number;
  aiAutoReplyEnabled?: boolean;
  aiSemanticClassificationEnabled?: boolean;
  aiCooldownSeconds?: number;
  aiMaxResponsesPerHour?: number | undefined;
  deletedMessageRetentionDays?: number | undefined;
  moderationDestructiveActionsEnabled?: boolean;
  dryRunEnabled?: boolean;
  vip?: boolean;
  neverAutoReply?: boolean;
  neverModerate?: boolean;
  quietHoursEnabled?: boolean;
  quietHoursTimezone?: string | undefined;
  quietHoursDays?: number[];
  quietHoursStartMinutes?: number | undefined;
  quietHoursEndMinutes?: number | undefined;
  approvalRequired?: boolean;
  mediaArchiveEnabled?: boolean;
  deletedMessageAlertMode?: DeletedMessageAlertMode;
}

/** The exact keys `PresetSettings` may carry — the single allowlist every read/write filters through. */
export const PRESET_SETTINGS_FIELDS = [
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
  'moderationDestructiveActionsEnabled',
  'dryRunEnabled',
  'vip',
  'neverAutoReply',
  'neverModerate',
  'quietHoursEnabled',
  'quietHoursTimezone',
  'quietHoursDays',
  'quietHoursStartMinutes',
  'quietHoursEndMinutes',
  'approvalRequired',
  'mediaArchiveEnabled',
  'deletedMessageAlertMode',
] as const satisfies readonly (keyof PresetSettings)[];

/** Strips anything outside `PRESET_SETTINGS_FIELDS` — defense in depth against a hand-edited row or a future settings field leaking in unreviewed. */
export function sanitizePresetSettings(
  input: Record<string, unknown> | PresetSettings,
): PresetSettings {
  const source = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of PRESET_SETTINGS_FIELDS) {
    if (Object.hasOwn(source, key)) out[key] = source[key];
  }
  return out as PresetSettings;
}

export interface GroupPreset {
  id: string;
  accountId: string;
  name: string;
  settings: PresetSettings;
  createdAt: string;
  updatedAt: string;
}

interface PresetRow {
  id: string;
  account_id: string;
  name: string;
  settings: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

function fromRow(row: PresetRow): GroupPreset {
  return {
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    settings: sanitizePresetSettings(row.settings ?? {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Named, reusable `group_settings` bundles ("Business", "Staff",
 * "Community", "Client", "AI Assistant", ...). Applying a preset to a group
 * is a one-time copy (`groupsRepository.updateSettings(groupId,
 * preset.settings)` — see src/web/groupRoutes.ts's `apply-preset` route),
 * never a live link: editing a preset afterward never changes any group
 * that already applied it, and editing one group's settings never changes
 * another group "because they share a preset" — there is no such
 * relationship once applied.
 */
export class PresetsRepository {
  constructor(private readonly supabase: SupabaseClient) {}

  async create(accountId: string, name: string, settings: PresetSettings): Promise<GroupPreset> {
    const now = new Date().toISOString();
    const { data, error } = await this.supabase
      .from('group_presets')
      .insert({
        id: randomUUID(),
        account_id: accountId,
        name,
        settings: sanitizePresetSettings(settings),
        created_at: now,
        updated_at: now,
      })
      .select('*')
      .maybeSingle();

    if (error || !data) {
      throw new Error(`Failed to create group preset: ${error?.message ?? 'no row returned'}`);
    }
    return fromRow(data as PresetRow);
  }

  async getById(id: string): Promise<GroupPreset | undefined> {
    const { data, error } = await this.supabase
      .from('group_presets')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) {
      throw new Error(`Failed to load group preset: ${error.message}`);
    }
    return data ? fromRow(data as PresetRow) : undefined;
  }

  async listByAccount(accountId: string): Promise<GroupPreset[]> {
    const { data, error } = await this.supabase
      .from('group_presets')
      .select('*')
      .eq('account_id', accountId)
      .order('name', { ascending: true });
    if (error) {
      throw new Error(`Failed to list group presets: ${error.message}`);
    }
    return (data ?? []).map((row) => fromRow(row as PresetRow));
  }

  async update(
    id: string,
    patch: { name?: string; settings?: PresetSettings },
  ): Promise<GroupPreset> {
    const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (patch.name !== undefined) row.name = patch.name;
    if (patch.settings !== undefined) row.settings = sanitizePresetSettings(patch.settings);

    const { data, error } = await this.supabase
      .from('group_presets')
      .update(row)
      .eq('id', id)
      .select('*')
      .maybeSingle();
    if (error || !data) {
      throw new Error(`Failed to update group preset: ${error?.message ?? 'no row returned'}`);
    }
    return fromRow(data as PresetRow);
  }

  async remove(id: string): Promise<void> {
    const { error } = await this.supabase.from('group_presets').delete().eq('id', id);
    if (error) {
      throw new Error(`Failed to delete group preset: ${error.message}`);
    }
  }

  /** Creates a new, independent preset from an existing one's current settings — never a reference back to the original. */
  async duplicate(id: string, newName: string): Promise<GroupPreset> {
    const existing = await this.getById(id);
    if (!existing) {
      throw new Error(`Preset not found: ${id}`);
    }
    return this.create(existing.accountId, newName, existing.settings);
  }
}

/** `GroupSettingsPatch` is a strict superset of `PresetSettings` — applying a preset is always a valid settings patch. */
export function presetSettingsToGroupPatch(settings: PresetSettings): GroupSettingsPatch {
  return { ...settings };
}
