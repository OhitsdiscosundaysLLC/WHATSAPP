import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

export type PendingApprovalStatus = 'pending' | 'approved' | 'rejected' | 'sent' | 'failed';

export interface CreatePendingApprovalInput {
  accountId: string;
  /** Exactly one of groupId/contactId — see pending_approvals_scope_check. */
  groupId?: string;
  contactId?: string;
  ruleId?: string;
  triggerWhatsappMessageId?: string;
  targetChatJid: string;
  proposedMessage: string;
}

export interface PendingApproval {
  id: string;
  accountId: string;
  groupId: string | undefined;
  contactId: string | undefined;
  ruleId: string | undefined;
  triggerWhatsappMessageId: string | undefined;
  targetChatJid: string;
  proposedMessage: string;
  status: PendingApprovalStatus;
  decidedBy: string | undefined;
  decidedAt: string | undefined;
  createdAt: string;
}

interface PendingApprovalRow {
  id: string;
  account_id: string;
  group_id: string | null;
  contact_id: string | null;
  rule_id: string | null;
  trigger_whatsapp_message_id: string | null;
  target_chat_jid: string;
  proposed_message: string;
  status: PendingApprovalStatus;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
}

function fromRow(row: PendingApprovalRow): PendingApproval {
  return {
    id: row.id,
    accountId: row.account_id,
    groupId: row.group_id ?? undefined,
    contactId: row.contact_id ?? undefined,
    ruleId: row.rule_id ?? undefined,
    triggerWhatsappMessageId: row.trigger_whatsapp_message_id ?? undefined,
    targetChatJid: row.target_chat_jid,
    proposedMessage: row.proposed_message,
    status: row.status,
    decidedBy: row.decided_by ?? undefined,
    decidedAt: row.decided_at ?? undefined,
    createdAt: row.created_at,
  };
}

/**
 * "Approval Before Send" (Phase 8): when a group/contact has
 * `approvalRequired` on, a qualifying auto_reply never sends directly —
 * it proposes a message here instead, surfaced in the Owner Inbox. Only
 * APPROVE actually dispatches it (optionally with owner-edited text);
 * REJECT discards it. Every status transition away from 'pending' is a
 * compare-and-set (`.eq('status', 'pending')`) so a double-tap of
 * Approve/Reject — or one of each in a race — can only ever win once; the
 * loser's update affects zero rows and the caller treats that as "already
 * decided," never as a silent no-op pretending to succeed.
 */
export class PendingApprovalsRepository {
  constructor(private readonly supabase: SupabaseClient) {}

  async create(input: CreatePendingApprovalInput): Promise<PendingApproval> {
    const now = new Date().toISOString();
    const { data, error } = await this.supabase
      .from('pending_approvals')
      .insert({
        id: randomUUID(),
        account_id: input.accountId,
        group_id: input.groupId ?? null,
        contact_id: input.contactId ?? null,
        rule_id: input.ruleId ?? null,
        trigger_whatsapp_message_id: input.triggerWhatsappMessageId ?? null,
        target_chat_jid: input.targetChatJid,
        proposed_message: input.proposedMessage,
        status: 'pending',
        decided_by: null,
        decided_at: null,
        created_at: now,
      })
      .select('*')
      .maybeSingle();

    if (error || !data) {
      throw new Error(`Failed to create pending approval: ${error?.message ?? 'no row returned'}`);
    }
    return fromRow(data as PendingApprovalRow);
  }

  async getById(id: string): Promise<PendingApproval | undefined> {
    const { data, error } = await this.supabase
      .from('pending_approvals')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) {
      throw new Error(`Failed to load pending approval: ${error.message}`);
    }
    return data ? fromRow(data as PendingApprovalRow) : undefined;
  }

  /** `accountId` omitted lists across every account — same "single owner, every account" precedent as OwnerInboxRepository.list(). */
  async list(
    accountId: string | undefined,
    options: { status?: PendingApprovalStatus; limit?: number } = {},
  ): Promise<PendingApproval[]> {
    let query = this.supabase
      .from('pending_approvals')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(options.limit ?? 50);
    if (accountId) query = query.eq('account_id', accountId);
    if (options.status) query = query.eq('status', options.status);

    const { data, error } = await query;
    if (error) {
      throw new Error(`Failed to list pending approvals: ${error.message}`);
    }
    return (data ?? []).map((row) => fromRow(row as PendingApprovalRow));
  }

  /**
   * Atomically moves a still-pending approval to 'approved', optionally
   * overwriting the proposed message with the owner's edit. Returns
   * `undefined` if it was no longer 'pending' (already approved/rejected
   * by a concurrent request) — the caller must treat that as "someone
   * already decided this," never retry-as-success.
   */
  async approve(
    id: string,
    decidedBy: string,
    editedMessage?: string,
  ): Promise<PendingApproval | undefined> {
    const patch: Record<string, unknown> = {
      status: 'approved',
      decided_by: decidedBy,
      decided_at: new Date().toISOString(),
    };
    if (editedMessage !== undefined) patch.proposed_message = editedMessage;

    const { data, error } = await this.supabase
      .from('pending_approvals')
      .update(patch)
      .eq('id', id)
      .eq('status', 'pending')
      .select('*')
      .maybeSingle();
    if (error) {
      throw new Error(`Failed to approve pending approval: ${error.message}`);
    }
    return data ? fromRow(data as PendingApprovalRow) : undefined;
  }

  /** Same compare-and-set guarantee as `approve()` — see its doc comment. */
  async reject(id: string, decidedBy: string): Promise<PendingApproval | undefined> {
    const { data, error } = await this.supabase
      .from('pending_approvals')
      .update({
        status: 'rejected',
        decided_by: decidedBy,
        decided_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('status', 'pending')
      .select('*')
      .maybeSingle();
    if (error) {
      throw new Error(`Failed to reject pending approval: ${error.message}`);
    }
    return data ? fromRow(data as PendingApprovalRow) : undefined;
  }

  /** Only a just-approved row can become 'sent' — enforced the same CAS way. */
  async markSent(id: string): Promise<boolean> {
    const { data, error } = await this.supabase
      .from('pending_approvals')
      .update({ status: 'sent' })
      .eq('id', id)
      .eq('status', 'approved')
      .select('id');
    if (error) {
      throw new Error(`Failed to mark pending approval sent: ${error.message}`);
    }
    return Array.isArray(data) && data.length > 0;
  }

  async markFailed(id: string): Promise<boolean> {
    const { data, error } = await this.supabase
      .from('pending_approvals')
      .update({ status: 'failed' })
      .eq('id', id)
      .eq('status', 'approved')
      .select('id');
    if (error) {
      throw new Error(`Failed to mark pending approval failed: ${error.message}`);
    }
    return Array.isArray(data) && data.length > 0;
  }
}
