import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

export type ActionType = 'SEND_MESSAGE' | 'LOG_ONLY' | 'NOTIFY_OWNER';
export type ActionStatus = 'success' | 'failed' | 'skipped';

export interface RecordActionInput {
  accountId: string | undefined;
  groupId: string | undefined;
  ruleId: string | undefined;
  triggerWhatsappMessageId: string | undefined;
  actionType: ActionType;
  status: ActionStatus;
  detail?: Record<string, unknown>;
}

export interface BotAction {
  id: string;
  accountId: string | undefined;
  groupId: string | undefined;
  ruleId: string | undefined;
  triggerWhatsappMessageId: string | undefined;
  actionType: ActionType;
  status: ActionStatus;
  detail: Record<string, unknown> | undefined;
  createdAt: string;
}

export interface RecordAuditInput {
  accountId: string | undefined;
  groupId: string | undefined;
  actor?: 'system' | 'owner';
  eventType: string;
  detail?: Record<string, unknown>;
}

export interface AuditLogEntry {
  id: string;
  accountId: string | undefined;
  groupId: string | undefined;
  actor: string;
  eventType: string;
  detail: Record<string, unknown> | undefined;
  createdAt: string;
}

interface BotActionRow {
  id: string;
  account_id: string | null;
  group_id: string | null;
  rule_id: string | null;
  trigger_whatsapp_message_id: string | null;
  action_type: ActionType;
  status: ActionStatus;
  detail: Record<string, unknown> | null;
  created_at: string;
}

interface AuditLogRow {
  id: string;
  account_id: string | null;
  group_id: string | null;
  actor: string;
  event_type: string;
  detail: Record<string, unknown> | null;
  created_at: string;
}

function fromActionRow(row: BotActionRow): BotAction {
  return {
    id: row.id,
    accountId: row.account_id ?? undefined,
    groupId: row.group_id ?? undefined,
    ruleId: row.rule_id ?? undefined,
    triggerWhatsappMessageId: row.trigger_whatsapp_message_id ?? undefined,
    actionType: row.action_type,
    status: row.status,
    detail: row.detail ?? undefined,
    createdAt: row.created_at,
  };
}

function fromAuditRow(row: AuditLogRow): AuditLogEntry {
  return {
    id: row.id,
    accountId: row.account_id ?? undefined,
    groupId: row.group_id ?? undefined,
    actor: row.actor,
    eventType: row.event_type,
    detail: row.detail ?? undefined,
    createdAt: row.created_at,
  };
}

/**
 * Records what the action engine did (`bot_actions`) and the general
 * activity feed the dashboard's Activity page reads from (`whatsapp_audit_logs`).
 * Never record credential/key material, ciphertext, or raw Baileys
 * payloads here — see docs/SECURITY.md.
 */
export class AuditRepository {
  constructor(private readonly supabase: SupabaseClient) {}

  async recordAction(input: RecordActionInput): Promise<void> {
    const { error } = await this.supabase.from('bot_actions').insert({
      id: randomUUID(),
      account_id: input.accountId ?? null,
      group_id: input.groupId ?? null,
      rule_id: input.ruleId ?? null,
      trigger_whatsapp_message_id: input.triggerWhatsappMessageId ?? null,
      action_type: input.actionType,
      status: input.status,
      detail: input.detail ?? null,
      created_at: new Date().toISOString(),
    });
    if (error) {
      throw new Error(`Failed to record bot action: ${error.message}`);
    }
  }

  async recordEvent(input: RecordAuditInput): Promise<void> {
    const { error } = await this.supabase.from('whatsapp_audit_logs').insert({
      id: randomUUID(),
      account_id: input.accountId ?? null,
      group_id: input.groupId ?? null,
      actor: input.actor ?? 'system',
      event_type: input.eventType,
      detail: input.detail ?? null,
      created_at: new Date().toISOString(),
    });
    if (error) {
      throw new Error(`Failed to record audit event: ${error.message}`);
    }
  }

  async listRecent(limit = 50, groupId?: string): Promise<AuditLogEntry[]> {
    let query = this.supabase
      .from('whatsapp_audit_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (groupId) {
      query = query.eq('group_id', groupId);
    }
    const { data, error } = await query;
    if (error) {
      throw new Error(`Failed to list audit log: ${error.message}`);
    }
    return (data ?? []).map((row) => fromAuditRow(row as AuditLogRow));
  }

  async listRecentActions(limit = 50, groupId?: string): Promise<BotAction[]> {
    let query = this.supabase
      .from('bot_actions')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (groupId) {
      query = query.eq('group_id', groupId);
    }
    const { data, error } = await query;
    if (error) {
      throw new Error(`Failed to list bot actions: ${error.message}`);
    }
    return (data ?? []).map((row) => fromActionRow(row as BotActionRow));
  }
}
