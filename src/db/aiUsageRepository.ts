import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface RecordAiUsageInput {
  accountId: string;
  groupId: string | undefined;
  contactId: string | undefined;
  ruleId: string | undefined;
  /** Why the AI service was invoked — e.g. 'auto_reply_classify', 'auto_reply_generate', 'command_ai_ask'. Never "every message". */
  reason: string;
  model: string;
  promptTokens: number | undefined;
  completionTokens: number | undefined;
  latencyMs: number;
  success: boolean;
  error: string | undefined;
}

/**
 * Records every AI service call — successful or not — and is the source of
 * truth `src/ai/aiUsagePolicy.ts` queries for the per-group AI cooldown and
 * max-responses-per-hour limits (no separate in-memory counter to drift out
 * of sync, and it survives a restart like every other durable state in this
 * project). Deliberately never stores prompt/response text — see
 * docs/SECURITY.md.
 */
export class AiUsageRepository {
  constructor(private readonly supabase: SupabaseClient) {}

  async record(input: RecordAiUsageInput): Promise<void> {
    const { error } = await this.supabase.from('whatsapp_ai_usage').insert({
      id: randomUUID(),
      account_id: input.accountId,
      group_id: input.groupId ?? null,
      contact_id: input.contactId ?? null,
      rule_id: input.ruleId ?? null,
      reason: input.reason,
      model: input.model,
      prompt_tokens: input.promptTokens ?? null,
      completion_tokens: input.completionTokens ?? null,
      latency_ms: input.latencyMs,
      success: input.success,
      error: input.error ?? null,
      created_at: new Date().toISOString(),
    });
    if (error) {
      throw new Error(`Failed to record AI usage: ${error.message}`);
    }
  }

  /** Successful calls for this group within the trailing window — drives the max-per-hour limit. */
  async countRecentSuccessful(groupId: string, since: Date): Promise<number> {
    const { count, error } = await this.supabase
      .from('whatsapp_ai_usage')
      .select('id', { count: 'exact', head: true })
      .eq('group_id', groupId)
      .eq('success', true)
      .gte('created_at', since.toISOString());
    if (error) {
      throw new Error(`Failed to count recent AI usage: ${error.message}`);
    }
    return count ?? 0;
  }

  /** Most recent successful call for this group — drives the AI cooldown. */
  async getLastSuccessfulAt(groupId: string): Promise<Date | undefined> {
    const { data, error } = await this.supabase
      .from('whatsapp_ai_usage')
      .select('created_at')
      .eq('group_id', groupId)
      .eq('success', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      throw new Error(`Failed to load last AI usage: ${error.message}`);
    }
    const row = data as { created_at: string } | null;
    return row ? new Date(row.created_at) : undefined;
  }

  /** Same as countRecentSuccessful, scoped to a private contact instead of a group. */
  async countRecentSuccessfulForContact(contactId: string, since: Date): Promise<number> {
    const { count, error } = await this.supabase
      .from('whatsapp_ai_usage')
      .select('id', { count: 'exact', head: true })
      .eq('contact_id', contactId)
      .eq('success', true)
      .gte('created_at', since.toISOString());
    if (error) {
      throw new Error(`Failed to count recent AI usage: ${error.message}`);
    }
    return count ?? 0;
  }

  /** Same as getLastSuccessfulAt, scoped to a private contact instead of a group. */
  async getLastSuccessfulAtForContact(contactId: string): Promise<Date | undefined> {
    const { data, error } = await this.supabase
      .from('whatsapp_ai_usage')
      .select('created_at')
      .eq('contact_id', contactId)
      .eq('success', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      throw new Error(`Failed to load last AI usage: ${error.message}`);
    }
    const row = data as { created_at: string } | null;
    return row ? new Date(row.created_at) : undefined;
  }
}
