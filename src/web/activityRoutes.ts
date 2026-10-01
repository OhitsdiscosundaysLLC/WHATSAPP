import { Router, type Request, type Response } from 'express';
import { AuditRepository } from '../db/auditRepository';
import { getSupabaseClient, isSupabaseConfigured } from '../db/supabaseClient';
import { attachSession, requireAuth } from './authMiddleware';

const MAX_LIMIT = 200;

/**
 * Read-only activity feed for the dashboard's Activity page — recent
 * `whatsapp_audit_logs` entries (message received, rule threshold progress, rule
 * fired, config changed, ...) and `bot_actions` (what the action engine
 * actually did and why). Never includes credentials, keys, or raw Baileys
 * payloads — see docs/SECURITY.md.
 */
export function createActivityRouter(): Router {
  const router = Router();
  router.use(attachSession, requireAuth);

  router.get('/', async (req: Request, res: Response) => {
    if (!isSupabaseConfigured()) {
      res.status(503).json({
        error: 'supabase_not_configured',
        message: 'Activity history requires Supabase to be configured. See docs/DEPLOYMENT.md.',
      });
      return;
    }

    const query = req.query as { groupId?: string; contactId?: string; limit?: string };
    const limit = Math.min(Number(query.limit) || 50, MAX_LIMIT);
    const groupId = typeof query.groupId === 'string' ? query.groupId : undefined;
    const contactId = typeof query.contactId === 'string' ? query.contactId : undefined;

    const auditRepository = new AuditRepository(getSupabaseClient());
    const [events, actions] = await Promise.all([
      auditRepository.listRecent(limit, groupId, contactId),
      auditRepository.listRecentActions(limit, groupId, contactId),
    ]);

    res.status(200).json({ events, actions });
  });

  return router;
}
