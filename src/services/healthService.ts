import { config } from '../config/config';

export type ComponentStatus = 'ok' | 'degraded' | 'down' | 'not_implemented';

export interface ComponentHealth {
  status: ComponentStatus;
  detail?: string;
}

export interface HealthReport {
  status: ComponentStatus;
  version: string;
  env: string;
  uptimeSeconds: number;
  timestamp: string;
  components: {
    database: ComponentHealth;
    whatsapp: ComponentHealth;
  };
}

/**
 * Reports real, honest status for each subsystem. A subsystem that hasn't
 * been built yet (per docs/DEVELOPMENT_PLAN.md) reports `not_implemented`
 * rather than a misleading `ok` — see docs/DECISIONS.md (ADR-005).
 */
export function getHealthReport(): HealthReport {
  const components: HealthReport['components'] = {
    database: {
      status: 'not_implemented',
      detail: config.supabase.configured
        ? 'Supabase credentials are configured, but the Phase 3 database integration is not implemented yet.'
        : 'Supabase credentials are not configured. Database integration lands in Phase 3.',
    },
    whatsapp: {
      status: 'not_implemented',
      detail: 'WhatsApp connectivity (Baileys) lands in Phase 2. No session is active.',
    },
  };

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
