import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createChildLogger } from '../services/logger';

const log = createChildLogger('db:contacts');

export interface WhatsAppContact {
  id: string;
  accountId: string;
  whatsappJid: string;
  displayName: string | undefined;
  blocked: boolean;
  /** Informational only — see docs/DECISIONS.md; does not gate any runtime behavior. */
  allowlisted: boolean;
  discoveredAt: string;
  updatedAt: string;
}

/**
 * Every private-chat automation toggle for one DM contact. Safe defaults:
 * everything `false` — a newly-discovered contact (the owner just received
 * a first DM) must never start automatically responding (product spec
 * goal 6, docs/SECURITY.md "Private-chat automation is opt-in").
 */
export interface ContactSettings {
  contactId: string;
  privateMonitoringEnabled: boolean;
  privateAiEnabled: boolean;
  privateAutoReplyEnabled: boolean;
  /** Explicit third gate (with privateAiEnabled + privateAutoReplyEnabled) required before an AI-generated private reply can fire. */
  privateAiAutoReplyEnabled: boolean;
  /** Whether a private rule is permitted to select the AI classifier at all. */
  privateAiSemanticClassificationEnabled: boolean;
  privateDeletedMessageArchiveEnabled: boolean;
  customInstructions: string | undefined;
  customAiInstructions: string | undefined;
  defaultCooldownSeconds: number;
  aiCooldownSeconds: number;
  aiMaxResponsesPerHour: number | undefined;
  deletedMessageRetentionDays: number | undefined;
  /** When true, the rule engine evaluates real events normally but logs "would have done X" instead of executing any action. */
  dryRunEnabled: boolean;
  updatedAt: string;
}

export const DEFAULT_CONTACT_SETTINGS: Omit<ContactSettings, 'contactId' | 'updatedAt'> = {
  privateMonitoringEnabled: false,
  privateAiEnabled: false,
  privateAutoReplyEnabled: false,
  privateAiAutoReplyEnabled: false,
  privateAiSemanticClassificationEnabled: false,
  privateDeletedMessageArchiveEnabled: false,
  customInstructions: undefined,
  customAiInstructions: undefined,
  defaultCooldownSeconds: 0,
  aiCooldownSeconds: 0,
  aiMaxResponsesPerHour: undefined,
  deletedMessageRetentionDays: undefined,
  dryRunEnabled: false,
};

export interface ContactSettingsPatch {
  privateMonitoringEnabled?: boolean;
  privateAiEnabled?: boolean;
  privateAutoReplyEnabled?: boolean;
  privateAiAutoReplyEnabled?: boolean;
  privateAiSemanticClassificationEnabled?: boolean;
  privateDeletedMessageArchiveEnabled?: boolean;
  customInstructions?: string | undefined;
  customAiInstructions?: string | undefined;
  defaultCooldownSeconds?: number;
  aiCooldownSeconds?: number;
  aiMaxResponsesPerHour?: number | undefined;
  deletedMessageRetentionDays?: number | undefined;
  dryRunEnabled?: boolean;
}

export interface ContactPatch {
  displayName?: string | undefined;
  blocked?: boolean;
  allowlisted?: boolean;
}

interface ContactRow {
  id: string;
  account_id: string;
  whatsapp_jid: string;
  display_name: string | null;
  blocked: boolean;
  allowlisted: boolean;
  discovered_at: string;
  updated_at: string;
}

interface ContactSettingsRow {
  contact_id: string;
  private_monitoring_enabled: boolean;
  private_ai_enabled: boolean;
  private_auto_reply_enabled: boolean;
  private_ai_auto_reply_enabled: boolean;
  private_ai_semantic_classification_enabled: boolean;
  private_deleted_message_archive_enabled: boolean;
  custom_instructions: string | null;
  custom_ai_instructions: string | null;
  default_cooldown_seconds: number;
  ai_cooldown_seconds: number;
  ai_max_responses_per_hour: number | null;
  deleted_message_retention_days: number | null;
  dry_run_enabled: boolean;
  updated_at: string;
}

function fromContactRow(row: ContactRow): WhatsAppContact {
  return {
    id: row.id,
    accountId: row.account_id,
    whatsappJid: row.whatsapp_jid,
    displayName: row.display_name ?? undefined,
    blocked: row.blocked,
    allowlisted: row.allowlisted,
    discoveredAt: row.discovered_at,
    updatedAt: row.updated_at,
  };
}

function fromSettingsRow(row: ContactSettingsRow): ContactSettings {
  return {
    contactId: row.contact_id,
    privateMonitoringEnabled: row.private_monitoring_enabled,
    privateAiEnabled: row.private_ai_enabled,
    privateAutoReplyEnabled: row.private_auto_reply_enabled,
    privateAiAutoReplyEnabled: row.private_ai_auto_reply_enabled,
    privateAiSemanticClassificationEnabled: row.private_ai_semantic_classification_enabled,
    privateDeletedMessageArchiveEnabled: row.private_deleted_message_archive_enabled,
    customInstructions: row.custom_instructions ?? undefined,
    customAiInstructions: row.custom_ai_instructions ?? undefined,
    defaultCooldownSeconds: row.default_cooldown_seconds,
    aiCooldownSeconds: row.ai_cooldown_seconds,
    aiMaxResponsesPerHour: row.ai_max_responses_per_hour ?? undefined,
    deletedMessageRetentionDays: row.deleted_message_retention_days ?? undefined,
    dryRunEnabled: row.dry_run_enabled,
    updatedAt: row.updated_at,
  };
}

function toSettingsPatchRow(patch: ContactSettingsPatch): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (patch.privateMonitoringEnabled !== undefined) {
    row.private_monitoring_enabled = patch.privateMonitoringEnabled;
  }
  if (patch.privateAiEnabled !== undefined) row.private_ai_enabled = patch.privateAiEnabled;
  if (patch.privateAutoReplyEnabled !== undefined) {
    row.private_auto_reply_enabled = patch.privateAutoReplyEnabled;
  }
  if (patch.privateAiAutoReplyEnabled !== undefined) {
    row.private_ai_auto_reply_enabled = patch.privateAiAutoReplyEnabled;
  }
  if (patch.privateAiSemanticClassificationEnabled !== undefined) {
    row.private_ai_semantic_classification_enabled = patch.privateAiSemanticClassificationEnabled;
  }
  if (patch.privateDeletedMessageArchiveEnabled !== undefined) {
    row.private_deleted_message_archive_enabled = patch.privateDeletedMessageArchiveEnabled;
  }
  if (patch.customInstructions !== undefined) {
    row.custom_instructions = patch.customInstructions || null;
  }
  if (patch.customAiInstructions !== undefined) {
    row.custom_ai_instructions = patch.customAiInstructions || null;
  }
  if (patch.defaultCooldownSeconds !== undefined) {
    row.default_cooldown_seconds = patch.defaultCooldownSeconds;
  }
  if (patch.aiCooldownSeconds !== undefined) row.ai_cooldown_seconds = patch.aiCooldownSeconds;
  if (patch.aiMaxResponsesPerHour !== undefined) {
    row.ai_max_responses_per_hour = patch.aiMaxResponsesPerHour ?? null;
  }
  if (patch.deletedMessageRetentionDays !== undefined) {
    row.deleted_message_retention_days = patch.deletedMessageRetentionDays ?? null;
  }
  if (patch.dryRunEnabled !== undefined) row.dry_run_enabled = patch.dryRunEnabled;
  return row;
}

/**
 * Durable WhatsApp private-contact registry + per-contact settings — the
 * DM-side equivalent of `GroupsRepository`. A contact is discovered lazily
 * (the first time a private message is seen from/to that JID, mirroring
 * group discovery) and always starts with safe-defaults (all-off) settings.
 */
export class ContactsRepository {
  constructor(private readonly supabase: SupabaseClient) {}

  /**
   * Upserts a discovered contact (identity = account + JID, never the
   * display name) and ensures a `contact_settings` row exists with safe
   * (all-off) defaults. Returns the contact whether newly discovered or
   * already known.
   */
  async upsertDiscoveredContact(
    accountId: string,
    whatsappJid: string,
    displayName: string | undefined,
  ): Promise<WhatsAppContact> {
    const { data: existing, error: selectError } = await this.supabase
      .from('whatsapp_contacts')
      .select('*')
      .eq('account_id', accountId)
      .eq('whatsapp_jid', whatsappJid)
      .maybeSingle();

    if (selectError) {
      throw new Error(`Failed to look up WhatsApp contact: ${selectError.message}`);
    }

    if (existing) {
      const row = existing as ContactRow;
      if (displayName && row.display_name !== displayName) {
        const now = new Date().toISOString();
        const { error: updateError } = await this.supabase
          .from('whatsapp_contacts')
          .update({ display_name: displayName, updated_at: now })
          .eq('id', row.id);
        if (updateError) {
          throw new Error(`Failed to update WhatsApp contact name: ${updateError.message}`);
        }
        return fromContactRow({ ...row, display_name: displayName, updated_at: now });
      }
      return fromContactRow(row);
    }

    const now = new Date().toISOString();
    const { data: inserted, error: insertError } = await this.supabase
      .from('whatsapp_contacts')
      .insert({
        id: randomUUID(),
        account_id: accountId,
        whatsapp_jid: whatsappJid,
        display_name: displayName ?? null,
        blocked: false,
        allowlisted: false,
        discovered_at: now,
        updated_at: now,
      })
      .select('*')
      .maybeSingle();

    if (insertError || !inserted) {
      throw new Error(
        `Failed to create WhatsApp contact: ${insertError?.message ?? 'no row returned'}`,
      );
    }

    const contact = fromContactRow(inserted as ContactRow);
    await this.ensureSettings(contact.id);
    log.info({ accountId, contactId: contact.id, whatsappJid }, 'Discovered new WhatsApp contact');
    return contact;
  }

  async ensureSettings(contactId: string): Promise<ContactSettings> {
    const existing = await this.getSettings(contactId);
    if (existing) return existing;

    const now = new Date().toISOString();
    const row = {
      contact_id: contactId,
      private_monitoring_enabled: DEFAULT_CONTACT_SETTINGS.privateMonitoringEnabled,
      private_ai_enabled: DEFAULT_CONTACT_SETTINGS.privateAiEnabled,
      private_auto_reply_enabled: DEFAULT_CONTACT_SETTINGS.privateAutoReplyEnabled,
      private_ai_auto_reply_enabled: DEFAULT_CONTACT_SETTINGS.privateAiAutoReplyEnabled,
      private_ai_semantic_classification_enabled:
        DEFAULT_CONTACT_SETTINGS.privateAiSemanticClassificationEnabled,
      private_deleted_message_archive_enabled:
        DEFAULT_CONTACT_SETTINGS.privateDeletedMessageArchiveEnabled,
      custom_instructions: null,
      custom_ai_instructions: null,
      default_cooldown_seconds: DEFAULT_CONTACT_SETTINGS.defaultCooldownSeconds,
      ai_cooldown_seconds: DEFAULT_CONTACT_SETTINGS.aiCooldownSeconds,
      ai_max_responses_per_hour: DEFAULT_CONTACT_SETTINGS.aiMaxResponsesPerHour ?? null,
      deleted_message_retention_days: DEFAULT_CONTACT_SETTINGS.deletedMessageRetentionDays ?? null,
      dry_run_enabled: DEFAULT_CONTACT_SETTINGS.dryRunEnabled,
      updated_at: now,
    };
    const { error } = await this.supabase
      .from('contact_settings')
      .upsert(row, { onConflict: 'contact_id' });
    if (error) {
      throw new Error(`Failed to create default contact settings: ${error.message}`);
    }
    return fromSettingsRow(row as ContactSettingsRow);
  }

  async getSettings(contactId: string): Promise<ContactSettings | undefined> {
    const { data, error } = await this.supabase
      .from('contact_settings')
      .select('*')
      .eq('contact_id', contactId)
      .maybeSingle();
    if (error) {
      throw new Error(`Failed to load contact settings: ${error.message}`);
    }
    return data ? fromSettingsRow(data as ContactSettingsRow) : undefined;
  }

  /** Partial update — never touches fields the caller didn't include. Each contact is independent. */
  async updateSettings(contactId: string, patch: ContactSettingsPatch): Promise<ContactSettings> {
    await this.ensureSettings(contactId);
    const row = { ...toSettingsPatchRow(patch), updated_at: new Date().toISOString() };
    const { data, error } = await this.supabase
      .from('contact_settings')
      .update(row)
      .eq('contact_id', contactId)
      .select('*')
      .maybeSingle();
    if (error || !data) {
      throw new Error(`Failed to update contact settings: ${error?.message ?? 'no row returned'}`);
    }
    return fromSettingsRow(data as ContactSettingsRow);
  }

  /** Updates blocked/allowlisted/displayName on the contact row itself (not its settings). */
  async updateContact(contactId: string, patch: ContactPatch): Promise<WhatsAppContact> {
    const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (patch.displayName !== undefined) row.display_name = patch.displayName || null;
    if (patch.blocked !== undefined) row.blocked = patch.blocked;
    if (patch.allowlisted !== undefined) row.allowlisted = patch.allowlisted;

    const { data, error } = await this.supabase
      .from('whatsapp_contacts')
      .update(row)
      .eq('id', contactId)
      .select('*')
      .maybeSingle();
    if (error || !data) {
      throw new Error(`Failed to update contact: ${error?.message ?? 'no row returned'}`);
    }
    return fromContactRow(data as ContactRow);
  }

  async listByAccount(accountId: string): Promise<WhatsAppContact[]> {
    const { data, error } = await this.supabase
      .from('whatsapp_contacts')
      .select('*')
      .eq('account_id', accountId)
      .order('updated_at', { ascending: false });
    if (error) {
      throw new Error(`Failed to list WhatsApp contacts: ${error.message}`);
    }
    return (data ?? []).map((row) => fromContactRow(row as ContactRow));
  }

  async listAll(): Promise<WhatsAppContact[]> {
    const { data, error } = await this.supabase
      .from('whatsapp_contacts')
      .select('*')
      .order('updated_at', { ascending: false });
    if (error) {
      throw new Error(`Failed to list WhatsApp contacts: ${error.message}`);
    }
    return (data ?? []).map((row) => fromContactRow(row as ContactRow));
  }

  async getById(contactId: string): Promise<WhatsAppContact | undefined> {
    const { data, error } = await this.supabase
      .from('whatsapp_contacts')
      .select('*')
      .eq('id', contactId)
      .maybeSingle();
    if (error) {
      throw new Error(`Failed to load WhatsApp contact: ${error.message}`);
    }
    return data ? fromContactRow(data as ContactRow) : undefined;
  }

  /** Looks up a contact by its WhatsApp JID (used by the event pipeline, which only has the JID). */
  async getByJid(accountId: string, whatsappJid: string): Promise<WhatsAppContact | undefined> {
    const { data, error } = await this.supabase
      .from('whatsapp_contacts')
      .select('*')
      .eq('account_id', accountId)
      .eq('whatsapp_jid', whatsappJid)
      .maybeSingle();
    if (error) {
      throw new Error(`Failed to look up WhatsApp contact: ${error.message}`);
    }
    return data ? fromContactRow(data as ContactRow) : undefined;
  }
}
