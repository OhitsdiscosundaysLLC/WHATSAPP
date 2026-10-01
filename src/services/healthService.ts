import { config } from '../config/config';
import type { DatabaseHealth } from '../db/supabaseClient';
import type { WhatsAppStatus } from '../whatsapp/types';

export type ComponentStatus = 'ok' | 'degraded' | 'down' | 'not_implemented';

export interface AuthPersistenceStatus {
  mode: 'file' | 'supabase' | 'unknown';
  durable: boolean;
  error?: string;
}

export interface WhatsAppComponentHealth {
  /** The actual internal connection state — never derived from socket presence alone. */
  status: WhatsAppStatus['state'];
  detail?: string | undefined;
  reconnectAttempt: number;
  lastConnectedAt?: string | undefined;
  lastDisconnectedAt?: string | undefined;
  /**
   * Whether WhatsApp auth state is actually durable right now (Supabase)
   * or ephemeral (local filesystem) — see docs/DECISIONS.md ADR-011.
   * Always surfaced, never hidden, so a misconfigured production
   * deployment is visible here rather than silently running ephemeral
   * storage. See docs/SECURITY.md.
   */
  authPersistence: AuthPersistenceStatus;
}

export interface HealthReport {
  status: ComponentStatus;
  version: string;
  env: string;
  uptimeSeconds: number;
  timestamp: string;
  components: {
    database: DatabaseHealth;
    whatsapp: WhatsAppComponentHealth;
    /** Never more than "is a key present" — this process never spends a real OpenAI call just to report health. */
    openai: { status: ComponentStatus };
    /** Media archive storage shares the Supabase project configured for `database` — see docs/ARCHITECTURE.md. */
    storage: { status: ComponentStatus };
  };
}

export interface HealthReportDeps {
  whatsapp: WhatsAppStatus;
  database: DatabaseHealth;
  authPersistence: AuthPersistenceStatus;
}

/**
 * Reports real, honest status for each subsystem. The caller supplies live
 * state (see src/server.ts) rather than this module reaching into
 * singletons itself, so it stays a plain, easily-testable composition
 * function.
 *
 * Never includes QR contents, credentials, keys, encryption keys, auth
 * file paths, Supabase project URLs/keys, or any WhatsApp account
 * metadata beyond the connection state machine — see docs/SECURITY.md.
 */
export function getHealthReport({
  whatsapp,
  database,
  authPersistence,
}: HealthReportDeps): HealthReport {
  const components: HealthReport['components'] = {
    database,
    whatsapp: {
      status: whatsapp.state,
      detail: whatsapp.detail,
      reconnectAttempt: whatsapp.reconnectAttempt,
      lastConnectedAt: whatsapp.lastConnectedAt,
      lastDisconnectedAt: whatsapp.lastDisconnectedAt,
      authPersistence,
    },
    openai: { status: config.openai.configured ? 'ok' : 'not_implemented' },
    storage: { status: database.status === 'ok' && config.supabase.configured ? 'ok' : 'down' },
  };

  // Liveness status: reflects whether the process itself is healthy, not
  // whether every dependency is connected (see docs/ARCHITECTURE.md on
  // readiness vs liveness, and GET /ready for a readiness check).
  const overall: ComponentStatus = 'ok';

  return {
    status: overall,
    version: config.appVersion,
    env: config.env,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    components,
  };
}

/** Readiness: is WhatsApp actually usable right now (or intentionally disabled)? */
export function getReadiness(whatsapp: WhatsAppStatus): {
  ready: boolean;
  whatsapp: WhatsAppStatus['state'];
  detail?: string | undefined;
} {
  const ready = !config.whatsapp.enabled || whatsapp.state === 'connected';
  return {
    ready,
    whatsapp: whatsapp.state,
    detail: whatsapp.detail,
  };
}
