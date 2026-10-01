import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface RecordCallEventInput {
  accountId: string;
  callerJid: string;
  chatJid: string;
  groupId: string | undefined;
  isGroup: boolean;
  isVideo: boolean;
  status: string;
  actionTaken: string | undefined;
}

export interface CallEventRecord {
  id: string;
  callerJid: string;
  status: string;
  isVideo: boolean;
  actionTaken: string | undefined;
  createdAt: string;
}

interface CallEventRow {
  id: string;
  caller_jid: string;
  status: string;
  is_video: boolean;
  action_taken: string | null;
  created_at: string;
}

/** Signaling metadata only — never call audio/video. See docs/DECISIONS.md ADR-001. */
export class CallEventsRepository {
  constructor(private readonly supabase: SupabaseClient) {}

  async record(input: RecordCallEventInput): Promise<void> {
    const { error } = await this.supabase.from('whatsapp_call_events').insert({
      id: randomUUID(),
      account_id: input.accountId,
      caller_jid: input.callerJid,
      chat_jid: input.chatJid,
      group_id: input.groupId ?? null,
      is_group: input.isGroup,
      is_video: input.isVideo,
      status: input.status,
      action_taken: input.actionTaken ?? null,
      created_at: new Date().toISOString(),
    });
    if (error) {
      throw new Error(`Failed to record call event: ${error.message}`);
    }
  }

  async listRecent(accountId: string, limit = 50): Promise<CallEventRecord[]> {
    const { data, error } = await this.supabase
      .from('whatsapp_call_events')
      .select('id, caller_jid, status, is_video, action_taken, created_at')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) {
      throw new Error(`Failed to list call events: ${error.message}`);
    }
    return (data ?? []).map((row) => {
      const r = row as CallEventRow;
      return {
        id: r.id,
        callerJid: r.caller_jid,
        status: r.status,
        isVideo: r.is_video,
        actionTaken: r.action_taken ?? undefined,
        createdAt: r.created_at,
      };
    });
  }
}
