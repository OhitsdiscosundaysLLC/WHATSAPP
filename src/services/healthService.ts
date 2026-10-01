import { config } from '../config/config';
import type { WhatsAppStatus } from '../whatsapp/types';

export type ComponentStatus = 'ok' | 'degraded' | 'down' | 'not_implemented';

export interface ComponentHealth {
  status: ComponentStatus;
  detail?: string;
}

export interface WhatsAppComponentHealth {
  /** The actual internal connection state — never derived from socket presence alone. */
  status: WhatsAppStatus['state'];
  detail?: string | undefined;
  reconnectAttempt: number;
  lastConnectedAt?: string | undefined;
  lastDisconnectedAt?: string | undefined;
}

export interface HealthReport {
  status: ComponentStatus;
  version: string;
  env: string;
  uptimeSeconds: number;
  timestamp: string;
  components: {
    database: ComponentHealth;
    whatsapp: WhatsAppComponentHealth;
  };
}

export interface HealthReportDeps {
  whatsapp: WhatsAppStatus;
}

/**
 * Reports real, honest status for each subsystem. The caller supplies the
 * live WhatsApp connection state (see src/server.ts) rather than this
 * module reaching into the WhatsApp singleton itself, so it stays a plain,
 * easily-testable composition function. Database remains `not_implemented`
 * until Phase 3 — see docs/DECISIONS.md (ADR-005).
 *
 * Never includes QR contents, credentials, keys, auth file paths, or any
 * WhatsApp account metadata beyond the connection state machine.
 */
export function getHealthReport({ whatsapp }: HealthReportDeps): HealthReport {
  const components: HealthReport['components'] = {
    database: {
      status: 'not_implemented',
      detail: config.supabase.configured
        ? 'Supabase credentials are configured, but the Phase 3 database integration is not implemented yet.'
        : 'Supabase credentials are not configured. Database integration lands in Phase 3.',
    },
    whatsapp: {
      status: whatsapp.state,
      detail: whatsapp.detail,
      reconnectAttempt: whatsapp.reconnectAttempt,
      lastConnectedAt: whatsapp.lastConnectedAt,
      lastDisconnectedAt: whatsapp.lastDisconnectedAt,
    },
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
