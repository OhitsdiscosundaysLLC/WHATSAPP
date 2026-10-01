import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createChildLogger } from '../services/logger';

const log = createChildLogger('db:groups');

export interface WhatsAppGroup {
  id: string;
  accountId: string;
  whatsappGroupJid: string;
  subject: string;
  discoveredAt: string;
  updatedAt: string;
}

/**
 * Every automation toggle for one group. Safe defaults: everything `false`
 * — see docs/DECISIONS.md ADR-012. Fields beyond `botEnabled`/
 * `monitoringEnabled` are configuration architecture for features not yet
 * implemented (Phase 6+); the dashboard must label them accordingly rather
 * than implying they do something today.
 */
export interface GroupSettings {
  groupId: string;
  botEnabled: boolean;
  monitoringEnabled: boolean;
  aiEnabled: boolean;
  autoReplyEnabled: boolean;
  deletedMessageArchiveEnabled: boolean;
  viewOnceHandlingEnabled: boolean;
  callHandlingEnabled: boolean;
  moderationEnabled: boolean;
  customGroupInstructions: string | undefined;
  customAiInstructions: string | undefined;
  defaultCooldownSeconds: number;
  updatedAt: string;
}

export const DEFAULT_GROUP_SETTINGS: Omit<GroupSettings, 'groupId' | 'updatedAt'> = {
  botEnabled: false,
  monitoringEnabled: false,
  aiEnabled: false,
  autoReplyEnabled: false,
  deletedMessageArchiveEnabled: false,
  viewOnceHandlingEnabled: false,
  callHandlingEnabled: false,
  moderationEnabled: false,
  customGroupInstructions: undefined,
  customAiInstructions: undefined,
  defaultCooldownSeconds: 0,
};

export interface GroupSettingsPatch {
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
}

interface GroupRow {
  id: string;
  account_id: string;
  whatsapp_group_jid: string;
  subject: string;
  discovered_at: string;
  updated_at: string;
}

interface GroupSettingsRow {
  group_id: string;
  bot_enabled: boolean;
  monitoring_enabled: boolean;
  ai_enabled: boolean;
  auto_reply_enabled: boolean;
  deleted_message_archive_enabled: boolean;
  view_once_handling_enabled: boolean;
  call_handling_enabled: boolean;
  moderation_enabled: boolean;
  custom_group_instructions: string | null;
  custom_ai_instructions: string | null;
  default_cooldown_seconds: number;
  updated_at: string;
}

function fromGroupRow(row: GroupRow): WhatsAppGroup {
  return {
    id: row.id,
    accountId: row.account_id,
    whatsappGroupJid: row.whatsapp_group_jid,
    subject: row.subject,
    discoveredAt: row.discovered_at,
    updatedAt: row.updated_at,
  };
}

function fromSettingsRow(row: GroupSettingsRow): GroupSettings {
  return {
    groupId: row.group_id,
    botEnabled: row.bot_enabled,
    monitoringEnabled: row.monitoring_enabled,
    aiEnabled: row.ai_enabled,
    autoReplyEnabled: row.auto_reply_enabled,
    deletedMessageArchiveEnabled: row.deleted_message_archive_enabled,
    viewOnceHandlingEnabled: row.view_once_handling_enabled,
    callHandlingEnabled: row.call_handling_enabled,
    moderationEnabled: row.moderation_enabled,
    customGroupInstructions: row.custom_group_instructions ?? undefined,
    customAiInstructions: row.custom_ai_instructions ?? undefined,
    defaultCooldownSeconds: row.default_cooldown_seconds,
    updatedAt: row.updated_at,
  };
}

function toSettingsPatchRow(patch: GroupSettingsPatch): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (patch.botEnabled !== undefined) row.bot_enabled = patch.botEnabled;
  if (patch.monitoringEnabled !== undefined) row.monitoring_enabled = patch.monitoringEnabled;
  if (patch.aiEnabled !== undefined) row.ai_enabled = patch.aiEnabled;
  if (patch.autoReplyEnabled !== undefined) row.auto_reply_enabled = patch.autoReplyEnabled;
  if (patch.deletedMessageArchiveEnabled !== undefined) {
    row.deleted_message_archive_enabled = patch.deletedMessageArchiveEnabled;
  }
  if (patch.viewOnceHandlingEnabled !== undefined) {
    row.view_once_handling_enabled = patch.viewOnceHandlingEnabled;
  }
  if (patch.callHandlingEnabled !== undefined)
    row.call_handling_enabled = patch.callHandlingEnabled;
  if (patch.moderationEnabled !== undefined) row.moderation_enabled = patch.moderationEnabled;
  if (patch.customGroupInstructions !== undefined) {
    row.custom_group_instructions = patch.customGroupInstructions || null;
  }
  if (patch.customAiInstructions !== undefined) {
    row.custom_ai_instructions = patch.customAiInstructions || null;
  }
  if (patch.defaultCooldownSeconds !== undefined) {
    row.default_cooldown_seconds = patch.defaultCooldownSeconds;
  }
  return row;
}

/**
 * Durable WhatsApp group registry + per-group settings. Supabase-only —
 * groups/rules are a production (Supabase-backed) feature set, same
 * reasoning as docs/DECISIONS.md ADR-011; there is no local-file
 * equivalent (see ADR-012).
 */
export class GroupsRepository {
  constructor(private readonly supabase: SupabaseClient) {}

  /**
   * Upserts a discovered group (identity = account + JID, never the display
   * name — a rename must update `subject` in place, not create a new row)
   * and ensures a `group_settings` row exists with safe (all-off) defaults.
   * Returns the group whether it was newly discovered or already known.
   */
  async upsertDiscoveredGroup(
    accountId: string,
    whatsappGroupJid: string,
    subject: string,
  ): Promise<WhatsAppGroup> {
    const { data: existing, error: selectError } = await this.supabase
      .from('whatsapp_groups')
      .select('id, account_id, whatsapp_group_jid, subject, discovered_at, updated_at')
      .eq('account_id', accountId)
      .eq('whatsapp_group_jid', whatsappGroupJid)
      .maybeSingle();

    if (selectError) {
      throw new Error(`Failed to look up WhatsApp group: ${selectError.message}`);
    }

    if (existing) {
      const row = existing as GroupRow;
      if (row.subject !== subject) {
        const now = new Date().toISOString();
        const { error: updateError } = await this.supabase
          .from('whatsapp_groups')
          .update({ subject, updated_at: now })
          .eq('id', row.id);
        if (updateError) {
          throw new Error(`Failed to update WhatsApp group subject: ${updateError.message}`);
        }
        return fromGroupRow({ ...row, subject, updated_at: now });
      }
      return fromGroupRow(row);
    }

    const now = new Date().toISOString();
    const { data: inserted, error: insertError } = await this.supabase
      .from('whatsapp_groups')
      .insert({
        id: randomUUID(),
        account_id: accountId,
        whatsapp_group_jid: whatsappGroupJid,
        subject,
        discovered_at: now,
        updated_at: now,
      })
      .select('id, account_id, whatsapp_group_jid, subject, discovered_at, updated_at')
      .maybeSingle();

    if (insertError || !inserted) {
      throw new Error(
        `Failed to create WhatsApp group: ${insertError?.message ?? 'no row returned'}`,
      );
    }

    const group = fromGroupRow(inserted as GroupRow);
    await this.ensureSettings(group.id);
    log.info({ accountId, groupId: group.id, whatsappGroupJid }, 'Discovered new WhatsApp group');
    return group;
  }

  /** Creates a safe-defaults `group_settings` row if one doesn't already exist. */
  async ensureSettings(groupId: string): Promise<GroupSettings> {
    const existing = await this.getSettings(groupId);
    if (existing) return existing;

    const now = new Date().toISOString();
    const row = {
      group_id: groupId,
      bot_enabled: DEFAULT_GROUP_SETTINGS.botEnabled,
      monitoring_enabled: DEFAULT_GROUP_SETTINGS.monitoringEnabled,
      ai_enabled: DEFAULT_GROUP_SETTINGS.aiEnabled,
      auto_reply_enabled: DEFAULT_GROUP_SETTINGS.autoReplyEnabled,
      deleted_message_archive_enabled: DEFAULT_GROUP_SETTINGS.deletedMessageArchiveEnabled,
      view_once_handling_enabled: DEFAULT_GROUP_SETTINGS.viewOnceHandlingEnabled,
      call_handling_enabled: DEFAULT_GROUP_SETTINGS.callHandlingEnabled,
      moderation_enabled: DEFAULT_GROUP_SETTINGS.moderationEnabled,
      custom_group_instructions: null,
      custom_ai_instructions: null,
      default_cooldown_seconds: DEFAULT_GROUP_SETTINGS.defaultCooldownSeconds,
      updated_at: now,
    };
    const { error } = await this.supabase
      .from('group_settings')
      .upsert(row, { onConflict: 'group_id' });
    if (error) {
      throw new Error(`Failed to create default group settings: ${error.message}`);
    }
    return fromSettingsRow(row as GroupSettingsRow);
  }

  async getSettings(groupId: string): Promise<GroupSettings | undefined> {
    const { data, error } = await this.supabase
      .from('group_settings')
      .select('*')
      .eq('group_id', groupId)
      .maybeSingle();
    if (error) {
      throw new Error(`Failed to load group settings: ${error.message}`);
    }
    return data ? fromSettingsRow(data as GroupSettingsRow) : undefined;
  }

  /** Partial update — never touches fields the caller didn't include. Each group is independent. */
  async updateSettings(groupId: string, patch: GroupSettingsPatch): Promise<GroupSettings> {
    await this.ensureSettings(groupId);
    const row = { ...toSettingsPatchRow(patch), updated_at: new Date().toISOString() };
    const { data, error } = await this.supabase
      .from('group_settings')
      .update(row)
      .eq('group_id', groupId)
      .select('*')
      .maybeSingle();
    if (error || !data) {
      throw new Error(`Failed to update group settings: ${error?.message ?? 'no row returned'}`);
    }
    return fromSettingsRow(data as GroupSettingsRow);
  }

  async listByAccount(accountId: string): Promise<WhatsAppGroup[]> {
    const { data, error } = await this.supabase
      .from('whatsapp_groups')
      .select('id, account_id, whatsapp_group_jid, subject, discovered_at, updated_at')
      .eq('account_id', accountId)
      .order('subject', { ascending: true });
    if (error) {
      throw new Error(`Failed to list WhatsApp groups: ${error.message}`);
    }
    return (data ?? []).map((row) => fromGroupRow(row as GroupRow));
  }

  async listAll(): Promise<WhatsAppGroup[]> {
    const { data, error } = await this.supabase
      .from('whatsapp_groups')
      .select('id, account_id, whatsapp_group_jid, subject, discovered_at, updated_at')
      .order('subject', { ascending: true });
    if (error) {
      throw new Error(`Failed to list WhatsApp groups: ${error.message}`);
    }
    return (data ?? []).map((row) => fromGroupRow(row as GroupRow));
  }

  async getById(groupId: string): Promise<WhatsAppGroup | undefined> {
    const { data, error } = await this.supabase
      .from('whatsapp_groups')
      .select('id, account_id, whatsapp_group_jid, subject, discovered_at, updated_at')
      .eq('id', groupId)
      .maybeSingle();
    if (error) {
      throw new Error(`Failed to load WhatsApp group: ${error.message}`);
    }
    return data ? fromGroupRow(data as GroupRow) : undefined;
  }

  /** Looks up a group by its WhatsApp JID (used by the event pipeline, which only has the JID). */
  async getByJid(accountId: string, whatsappGroupJid: string): Promise<WhatsAppGroup | undefined> {
    const { data, error } = await this.supabase
      .from('whatsapp_groups')
      .select('id, account_id, whatsapp_group_jid, subject, discovered_at, updated_at')
      .eq('account_id', accountId)
      .eq('whatsapp_group_jid', whatsappGroupJid)
      .maybeSingle();
    if (error) {
      throw new Error(`Failed to look up WhatsApp group: ${error.message}`);
    }
    return data ? fromGroupRow(data as GroupRow) : undefined;
  }
}
