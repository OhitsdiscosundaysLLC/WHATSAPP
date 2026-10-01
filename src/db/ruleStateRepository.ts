import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface RuleMatch {
  id: string;
  ruleId: string;
  targetWhatsappMessageId: string;
  fired: boolean;
  firedAt: string | undefined;
}

interface RuleMatchRow {
  id: string;
  rule_id: string;
  target_whatsapp_message_id: string;
  fired: boolean;
  fired_at: string | null;
}

function fromMatchRow(row: RuleMatchRow): RuleMatch {
  return {
    id: row.id,
    ruleId: row.rule_id,
    targetWhatsappMessageId: row.target_whatsapp_message_id,
    fired: row.fired,
    firedAt: row.fired_at ?? undefined,
  };
}

/**
 * Durable rule-evaluation state (Phase 5) — threshold progress, distinct
 * responders, fired state, and cooldowns all live in Supabase, never in
 * process memory. A Render restart mid-threshold (e.g. "3 of 5 people
 * responded") must not lose progress — see docs/DECISIONS.md ADR-012 and
 * product spec #14.
 */
export class RuleStateRepository {
  constructor(private readonly supabase: SupabaseClient) {}

  /** Finds or creates the progress record for one (rule, target message) pair. */
  async getOrCreateMatch(ruleId: string, targetWhatsappMessageId: string): Promise<RuleMatch> {
    const { data: existing, error: selectError } = await this.supabase
      .from('rule_matches')
      .select('*')
      .eq('rule_id', ruleId)
      .eq('target_whatsapp_message_id', targetWhatsappMessageId)
      .maybeSingle();
    if (selectError) {
      throw new Error(`Failed to load rule match: ${selectError.message}`);
    }
    if (existing) return fromMatchRow(existing as RuleMatchRow);

    const now = new Date().toISOString();
    const { data: inserted, error: insertError } = await this.supabase
      .from('rule_matches')
      .insert({
        id: randomUUID(),
        rule_id: ruleId,
        target_whatsapp_message_id: targetWhatsappMessageId,
        fired: false,
        created_at: now,
        updated_at: now,
      })
      .select('*')
      .maybeSingle();
    if (insertError || !inserted) {
      // Another concurrent event for the same target message may have
      // inserted first (the unique constraint caught it) — re-read rather
      // than failing, since the row now certainly exists.
      const { data: raced, error: racedError } = await this.supabase
        .from('rule_matches')
        .select('*')
        .eq('rule_id', ruleId)
        .eq('target_whatsapp_message_id', targetWhatsappMessageId)
        .maybeSingle();
      if (racedError || !raced) {
        throw new Error(
          `Failed to create rule match: ${insertError?.message ?? 'no row returned'}`,
        );
      }
      return fromMatchRow(raced as RuleMatchRow);
    }
    return fromMatchRow(inserted as RuleMatchRow);
  }

  /**
   * Records one distinct qualifying responder. The composite primary key
   * on `rule_match_responders(rule_match_id, sender_jid)` is what actually
   * enforces "distinct senders only" — a second response from the same
   * sender is structurally a no-op here, not an application-level count.
   */
  async addResponder(
    ruleMatchId: string,
    senderJid: string,
    whatsappMessageId: string,
  ): Promise<void> {
    const { error } = await this.supabase.from('rule_match_responders').upsert(
      {
        rule_match_id: ruleMatchId,
        sender_jid: senderJid,
        whatsapp_message_id: whatsappMessageId,
        responded_at: new Date().toISOString(),
      },
      { onConflict: 'rule_match_id,sender_jid' },
    );
    if (error) {
      throw new Error(`Failed to record rule responder: ${error.message}`);
    }
  }

  async countDistinctResponders(ruleMatchId: string): Promise<number> {
    const { data, error } = await this.supabase
      .from('rule_match_responders')
      .select('sender_jid')
      .eq('rule_match_id', ruleMatchId);
    if (error) {
      throw new Error(`Failed to count rule responders: ${error.message}`);
    }
    return (data ?? []).length;
  }

  /**
   * Atomically marks the match as fired — `true` only for the caller that
   * actually flips `fired` from false to true (the `.eq('fired', false)`
   * filter applies to the UPDATE itself, so this is race-safe even under
   * concurrent evaluation of the same target message). Every other caller
   * gets `false` and must not execute the action again.
   */
  async tryMarkFired(ruleMatchId: string): Promise<boolean> {
    const { data, error } = await this.supabase
      .from('rule_matches')
      .update({
        fired: true,
        fired_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', ruleMatchId)
      .eq('fired', false)
      .select('id');
    if (error) {
      throw new Error(`Failed to mark rule match fired: ${error.message}`);
    }
    return Array.isArray(data) && data.length > 0;
  }

  async getLastFiredAt(ruleId: string): Promise<Date | undefined> {
    const { data, error } = await this.supabase
      .from('rule_cooldowns')
      .select('last_fired_at')
      .eq('rule_id', ruleId)
      .maybeSingle();
    if (error) {
      throw new Error(`Failed to load rule cooldown: ${error.message}`);
    }
    const row = data as { last_fired_at: string } | null;
    return row ? new Date(row.last_fired_at) : undefined;
  }

  async recordFired(ruleId: string, firedAt: Date): Promise<void> {
    const { error } = await this.supabase
      .from('rule_cooldowns')
      .upsert({ rule_id: ruleId, last_fired_at: firedAt.toISOString() }, { onConflict: 'rule_id' });
    if (error) {
      throw new Error(`Failed to record rule cooldown: ${error.message}`);
    }
  }
}
