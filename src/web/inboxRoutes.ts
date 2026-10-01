import { Router, type Request, type Response } from 'express';
import { OwnerInboxRepository } from '../db/ownerInboxRepository';
import { getSupabaseClient, isSupabaseConfigured } from '../db/supabaseClient';
import { attachSession, requireAuth, requireCsrf } from './authMiddleware';

const MAX_LIMIT = 200;

/**
 * The Owner Inbox — a human-readable "look at this" feed, distinct from the
 * full raw whatsapp_audit_logs/bot_actions trail the Activity page reads.
 * Not account-scoped by default (same precedent as src/web/activityRoutes.ts
 * — this dashboard is single-owner across every connected WhatsApp account).
 * See src/db/ownerInboxRepository.ts.
 */
export function createInboxRouter(): Router {
  const router = Router();
  router.use(attachSession, requireAuth);

  router.get('/', async (req: Request, res: Response) => {
    if (!isSupabaseConfigured()) {
      res.status(503).json({
        error: 'supabase_not_configured',
        message: 'The Owner Inbox requires Supabase to be configured. See docs/DEPLOYMENT.md.',
      });
      return;
    }

    const query = req.query as {
      accountId?: string;
      unreadOnly?: string;
      includeDismissed?: string;
      limit?: string;
    };
    const limit = Math.min(Number(query.limit) || 50, MAX_LIMIT);

    const inbox = new OwnerInboxRepository(getSupabaseClient());
    const items = await inbox.list(query.accountId, {
      unreadOnly: query.unreadOnly === 'true',
      includeDismissed: query.includeDismissed === 'true',
      limit,
    });

    res.status(200).json({ items });
  });

  router.post('/:id/read', requireCsrf, async (req: Request, res: Response) => {
    if (!isSupabaseConfigured()) {
      res.status(503).json({ error: 'supabase_not_configured' });
      return;
    }
    const { id } = req.params as { id: string };
    const inbox = new OwnerInboxRepository(getSupabaseClient());
    await inbox.markRead(id);
    res.status(200).json({ ok: true });
  });

  router.post('/:id/dismiss', requireCsrf, async (req: Request, res: Response) => {
    if (!isSupabaseConfigured()) {
      res.status(503).json({ error: 'supabase_not_configured' });
      return;
    }
    const { id } = req.params as { id: string };
    const inbox = new OwnerInboxRepository(getSupabaseClient());
    await inbox.dismiss(id);
    res.status(200).json({ ok: true });
  });

  return router;
}
