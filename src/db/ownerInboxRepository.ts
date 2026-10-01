import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

export type InboxCategory =
  | 'deleted_message'
  | 'missed_call'
  | 'moderation'
  | 'ai_failure'
  | 'disconnected'
  | 'automation_failure'
  | 'rule_fired';

export interface RecordInboxItemInput {
  accountId: string;
  groupId?: string;
  contactId?: string;
  category: InboxCategory;
  title: string;
  detail?: Record<string, unknown>;
}

export interface OwnerInboxItem {
  id: string;
  accountId: string;
  groupId: string | undefined;
  contactId: string | undefined;
  category: InboxCategory;
  title: string;
  detail: Record<string, unknown> | undefined;
  read: boolean;
  dismissed: boolean;
  createdAt: string;
}

interface InboxRow {
  id: string;
  account_id: string;
  group_id: string | null;
  contact_id: string | null;
  category: InboxCategory;
  title: string;
  detail: Record<string, unknown> | null;
  read: boolean;
  dismissed: boolean;
  created_at: string;
}

function fromRow(row: InboxRow): OwnerInboxItem {
  return {
    id: row.id,
    accountId: row.account_id,
    groupId: row.group_id ?? undefined,
    contactId: row.contact_id ?? undefined,
    category: row.category,
    title: row.title,
    detail: row.detail ?? undefined,
    read: row.read,
    dismissed: row.dismissed,
    createdAt: row.created_at,
  };
}

/**
 * A human-readable operations feed for the dashboard's Owner Inbox — the
 * "things the owner should actually look at" subset of everything the bot
 * does, distinct from the full whatsapp_audit_logs/bot_actions trail the
 * Activity page reads (every rule evaluation, every message received).
 * Only ever populated from structured event data already known at the
 * call site — never AI-generated guessing about what happened.
 */
export class OwnerInboxRepository {
  constructor(private readonly supabase: SupabaseClient) {}

  async record(input: RecordInboxItemInput): Promise<void> {
    const { error } = await this.supabase.from('owner_inbox_items').insert({
      id: randomUUID(),
      account_id: input.accountId,
      group_id: input.groupId ?? null,
      contact_id: input.contactId ?? null,
      category: input.category,
      title: input.title,
      detail: input.detail ?? null,
      read: false,
      dismissed: false,
      created_at: new Date().toISOString(),
    });
    if (error) {
      throw new Error(`Failed to record owner inbox item: ${error.message}`);
    }
  }

  async list(
    accountId: string | undefined,
    options: { unreadOnly?: boolean; includeDismissed?: boolean; limit?: number } = {},
  ): Promise<OwnerInboxItem[]> {
    let query = this.supabase
      .from('owner_inbox_items')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(options.limit ?? 50);
    if (accountId) query = query.eq('account_id', accountId);
    if (options.unreadOnly) query = query.eq('read', false);
    if (!options.includeDismissed) query = query.eq('dismissed', false);

    const { data, error } = await query;
    if (error) {
      throw new Error(`Failed to list owner inbox items: ${error.message}`);
    }
    return (data ?? []).map((row) => fromRow(row as InboxRow));
  }

  async markRead(id: string): Promise<void> {
    const { error } = await this.supabase
      .from('owner_inbox_items')
      .update({ read: true })
      .eq('id', id);
    if (error) {
      throw new Error(`Failed to mark owner inbox item read: ${error.message}`);
    }
  }

  async dismiss(id: string): Promise<void> {
    const { error } = await this.supabase
      .from('owner_inbox_items')
      .update({ dismissed: true, read: true })
      .eq('id', id);
    if (error) {
      throw new Error(`Failed to dismiss owner inbox item: ${error.message}`);
    }
  }
}
