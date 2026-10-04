import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { validateRuleConfig, type GroupRuleConfig } from '../rules/ruleConfig';

export interface GroupRule {
  id: string;
  /** Exactly one of groupId/contactId is set — see group_rules_scope_check. */
  groupId: string | undefined;
  contactId: string | undefined;
  name: string;
  enabled: boolean;
  triggerType: string;
  config: GroupRuleConfig;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRuleInput {
  groupId: string;
  name: string;
  triggerType: string;
  config: unknown;
  enabled?: boolean;
}

export interface CreateContactRuleInput {
  contactId: string;
  name: string;
  /** Only 'auto_reply'/'escalation' make sense for a 1:1 DM — no distinct-responder threshold, no participant moderation. */
  triggerType: 'auto_reply' | 'escalation';
  config: unknown;
  enabled?: boolean;
}

export interface UpdateRuleInput {
  name?: string;
  config?: unknown;
  enabled?: boolean;
}

interface RuleRow {
  id: string;
  group_id: string | null;
  contact_id: string | null;
  name: string;
  enabled: boolean;
  trigger_type: string;
  config: unknown;
  created_at: string;
  updated_at: string;
}

function fromRow(row: RuleRow): GroupRule {
  // Re-validate on every read, not just on write — a config that was valid
  // when written must still be interpreted strictly, never trusted as
  // "already checked once" (defense in depth against a row edited directly
  // or by a future migration).
  const config = validateRuleConfig(row.trigger_type, row.config);
  return {
    id: row.id,
    groupId: row.group_id ?? undefined,
    contactId: row.contact_id ?? undefined,
    name: row.name,
    enabled: row.enabled,
    triggerType: row.trigger_type,
    config,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Rule definitions scoped to a group (Phase 5). Every write and every read
 * goes through `validateRuleConfig()` — the database's `jsonb` column is
 * never treated as pre-validated or safe to execute as-is. See
 * src/rules/ruleConfig.ts.
 */
export class RulesRepository {
  constructor(private readonly supabase: SupabaseClient) {}

  async create(input: CreateRuleInput): Promise<GroupRule> {
    const config = validateRuleConfig(input.triggerType, input.config);
    const now = new Date().toISOString();

    const { data, error } = await this.supabase
      .from('group_rules')
      .insert({
        id: randomUUID(),
        group_id: input.groupId,
        name: input.name,
        enabled: input.enabled ?? true,
        trigger_type: input.triggerType,
        config,
        created_at: now,
        updated_at: now,
      })
      .select('*')
      .maybeSingle();

    if (error || !data) {
      throw new Error(`Failed to create rule: ${error?.message ?? 'no row returned'}`);
    }
    return fromRow(data as RuleRow);
  }

  /** Creates a rule scoped to a private contact instead of a group — only `auto_reply` is valid here. */
  async createForContact(input: CreateContactRuleInput): Promise<GroupRule> {
    const config = validateRuleConfig(input.triggerType, input.config);
    const now = new Date().toISOString();

    const { data, error } = await this.supabase
      .from('group_rules')
      .insert({
        id: randomUUID(),
        group_id: null,
        contact_id: input.contactId,
        name: input.name,
        enabled: input.enabled ?? true,
        trigger_type: input.triggerType,
        config,
        created_at: now,
        updated_at: now,
      })
      .select('*')
      .maybeSingle();

    if (error || !data) {
      throw new Error(`Failed to create contact rule: ${error?.message ?? 'no row returned'}`);
    }
    return fromRow(data as RuleRow);
  }

  async update(ruleId: string, patch: UpdateRuleInput): Promise<GroupRule> {
    const existing = await this.getById(ruleId);
    if (!existing) {
      throw new Error(`Rule not found: ${ruleId}`);
    }

    const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (patch.name !== undefined) row.name = patch.name;
    if (patch.enabled !== undefined) row.enabled = patch.enabled;
    if (patch.config !== undefined) {
      row.config = validateRuleConfig(existing.triggerType, patch.config);
    }

    const { data, error } = await this.supabase
      .from('group_rules')
      .update(row)
      .eq('id', ruleId)
      .select('*')
      .maybeSingle();

    if (error || !data) {
      throw new Error(`Failed to update rule: ${error?.message ?? 'no row returned'}`);
    }
    return fromRow(data as RuleRow);
  }

  async setEnabled(ruleId: string, enabled: boolean): Promise<GroupRule> {
    return this.update(ruleId, { enabled });
  }

  async remove(ruleId: string): Promise<void> {
    const { error } = await this.supabase.from('group_rules').delete().eq('id', ruleId);
    if (error) {
      throw new Error(`Failed to delete rule: ${error.message}`);
    }
  }

  async getById(ruleId: string): Promise<GroupRule | undefined> {
    const { data, error } = await this.supabase
      .from('group_rules')
      .select('*')
      .eq('id', ruleId)
      .maybeSingle();
    if (error) {
      throw new Error(`Failed to load rule: ${error.message}`);
    }
    return data ? fromRow(data as RuleRow) : undefined;
  }

  async listByGroup(groupId: string): Promise<GroupRule[]> {
    const { data, error } = await this.supabase
      .from('group_rules')
      .select('*')
      .eq('group_id', groupId)
      .order('created_at', { ascending: true });
    if (error) {
      throw new Error(`Failed to list rules: ${error.message}`);
    }
    return (data ?? []).map((row) => fromRow(row as RuleRow));
  }

  /** Only enabled rules — what the rule engine actually evaluates against an incoming event. */
  async listEnabledByGroup(groupId: string): Promise<GroupRule[]> {
    const { data, error } = await this.supabase
      .from('group_rules')
      .select('*')
      .eq('group_id', groupId)
      .eq('enabled', true);
    if (error) {
      throw new Error(`Failed to list enabled rules: ${error.message}`);
    }
    return (data ?? []).map((row) => fromRow(row as RuleRow));
  }

  async listByContact(contactId: string): Promise<GroupRule[]> {
    const { data, error } = await this.supabase
      .from('group_rules')
      .select('*')
      .eq('contact_id', contactId)
      .order('created_at', { ascending: true });
    if (error) {
      throw new Error(`Failed to list contact rules: ${error.message}`);
    }
    return (data ?? []).map((row) => fromRow(row as RuleRow));
  }

  /** Only enabled rules for this contact — what the rule engine evaluates against an incoming private message. */
  async listEnabledByContact(contactId: string): Promise<GroupRule[]> {
    const { data, error } = await this.supabase
      .from('group_rules')
      .select('*')
      .eq('contact_id', contactId)
      .eq('enabled', true);
    if (error) {
      throw new Error(`Failed to list enabled contact rules: ${error.message}`);
    }
    return (data ?? []).map((row) => fromRow(row as RuleRow));
  }
}
