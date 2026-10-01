import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config/config';
import { createChildLogger } from '../services/logger';

const log = createChildLogger('db:supabase');

let client: SupabaseClient | null = null;

export function isSupabaseConfigured(): boolean {
  return config.supabase.configured;
}

/**
 * Lazily creates the shared server-side Supabase client, using the
 * service role key. Never import this from anything that runs in a
 * browser — there is no browser-facing code in this project, but this
 * comment exists so it stays that way. See docs/SECURITY.md.
 */
export function getSupabaseClient(): SupabaseClient {
  if (!config.supabase.url || !config.supabase.serviceRoleKey) {
    throw new Error(
      'Supabase is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing)',
    );
  }
  if (!client) {
    client = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

export type DatabaseHealthStatus = 'ok' | 'unavailable' | 'not_configured';

export interface DatabaseHealth {
  status: DatabaseHealthStatus;
  detail?: string;
}

/**
 * Cheap connectivity check for `/health` — a single `head`-only count
 * query with a short timeout. Never returns table contents, row counts
 * beyond existence, or any identifying project detail; failures are
 * logged with the driver's error message/code only, never request/response
 * bodies that could contain row data.
 */
export async function checkDatabaseHealth(timeoutMs = 3000): Promise<DatabaseHealth> {
  if (!config.supabase.configured) {
    return {
      status: 'not_configured',
      detail: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set.',
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('whatsapp_accounts')
      .select('id', { count: 'exact', head: true })
      .abortSignal(controller.signal);

    if (error) {
      log.warn({ err: error.message, code: error.code }, 'Supabase health check query failed');
      return { status: 'unavailable', detail: 'Database query failed.' };
    }
    return { status: 'ok' };
  } catch (err) {
    log.warn({ err }, 'Supabase health check failed');
    return { status: 'unavailable', detail: 'Could not reach the database.' };
  } finally {
    clearTimeout(timer);
  }
}
