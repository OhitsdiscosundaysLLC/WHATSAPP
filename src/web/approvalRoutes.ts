import { Router, type Request, type Response } from 'express';
import { AuditRepository } from '../db/auditRepository';
import { OwnerInboxRepository } from '../db/ownerInboxRepository';
import { PendingApprovalsRepository } from '../db/pendingApprovalsRepository';
import { getSupabaseClient, isSupabaseConfigured } from '../db/supabaseClient';
import { createChildLogger } from '../services/logger';
import { accountManager } from '../whatsapp/accountManager';
import { attachSession, requireAuth, requireCsrf } from './authMiddleware';

const log = createChildLogger('web:approvals');
const MAX_LIMIT = 200;

/**
 * "Approval Before Send" (Phase 8): a dashboard surface for the proposed
 * replies the rule engine held back (see src/rules/ruleEngine.ts's
 * `settings.approvalRequired` branch and src/db/pendingApprovalsRepository.ts).
 * Not account-scoped by default — same single-owner-across-accounts
 * precedent as src/web/inboxRoutes.ts and src/web/activityRoutes.ts.
 */
export function createApprovalRouter(): Router {
  const router = Router();
  router.use(attachSession, requireAuth);

  router.get('/', async (req: Request, res: Response) => {
    if (!isSupabaseConfigured()) {
      res.status(503).json({
        error: 'supabase_not_configured',
        message: 'Approval Before Send requires Supabase to be configured. See docs/DEPLOYMENT.md.',
      });
      return;
    }

    const query = req.query as { accountId?: string; status?: string; limit?: string };
    const limit = Math.min(Number(query.limit) || 50, MAX_LIMIT);
    const status =
      query.status === 'pending' ||
      query.status === 'approved' ||
      query.status === 'rejected' ||
      query.status === 'sent' ||
      query.status === 'failed'
        ? query.status
        : undefined;

    const pendingApprovals = new PendingApprovalsRepository(getSupabaseClient());
    const approvals = await pendingApprovals.list(query.accountId, {
      ...(status ? { status } : {}),
      limit,
    });
    const accounts = new Map(accountManager.listAccounts().map((a) => [a.id, a.label]));
    const payload = approvals.map((approval) => ({
      ...approval,
      accountLabel: accounts.get(approval.accountId) ?? 'Unknown account',
    }));
    res.status(200).json({ approvals: payload });
  });

  router.post('/:id/approve', requireCsrf, async (req: Request, res: Response) => {
    if (!isSupabaseConfigured()) {
      res.status(503).json({ error: 'supabase_not_configured' });
      return;
    }
    const { id } = req.params as { id: string };
    const body = req.body as { editedMessage?: unknown } | undefined;
    const editedMessage =
      typeof body?.editedMessage === 'string' && body.editedMessage.trim()
        ? body.editedMessage.trim()
        : undefined;

    const supabase = getSupabaseClient();
    const pendingApprovals = new PendingApprovalsRepository(supabase);
    const auditRepository = new AuditRepository(supabase);
    const ownerInbox = new OwnerInboxRepository(supabase);

    const approved = await pendingApprovals.approve(id, 'owner', editedMessage);
    if (!approved) {
      res.status(409).json({
        error: 'already_decided',
        message: 'This item is no longer pending — it was already approved, rejected, or sent.',
      });
      return;
    }

    try {
      await accountManager.sendTextMessage(
        approved.accountId,
        approved.targetChatJid,
        approved.proposedMessage,
      );
      await pendingApprovals.markSent(id);
      await auditRepository.recordEvent({
        accountId: approved.accountId,
        groupId: approved.groupId,
        contactId: approved.contactId,
        actor: 'owner',
        eventType: 'approval.approved',
        detail: { approvalId: id, ruleId: approved.ruleId, edited: editedMessage !== undefined },
      });
      res.status(200).json({ approval: { ...approved, status: 'sent' } });
    } catch (err) {
      await pendingApprovals.markFailed(id);
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.warn({ err, approvalId: id }, 'Failed to send approved reply');
      await ownerInbox.record({
        accountId: approved.accountId,
        ...(approved.groupId ? { groupId: approved.groupId } : {}),
        ...(approved.contactId ? { contactId: approved.contactId } : {}),
        category: 'automation_failure',
        title: 'Approved reply failed to send',
        detail: { approvalId: id, ruleId: approved.ruleId, error: errorMessage },
      });
      res.status(502).json({
        error: 'send_failed',
        message: 'The reply was approved but could not be sent. See the Owner Inbox.',
      });
    }
  });

  router.post('/:id/reject', requireCsrf, async (req: Request, res: Response) => {
    if (!isSupabaseConfigured()) {
      res.status(503).json({ error: 'supabase_not_configured' });
      return;
    }
    const { id } = req.params as { id: string };
    const supabase = getSupabaseClient();
    const pendingApprovals = new PendingApprovalsRepository(supabase);
    const auditRepository = new AuditRepository(supabase);

    const rejected = await pendingApprovals.reject(id, 'owner');
    if (!rejected) {
      res.status(409).json({
        error: 'already_decided',
        message: 'This item is no longer pending — it was already approved, rejected, or sent.',
      });
      return;
    }

    await auditRepository.recordEvent({
      accountId: rejected.accountId,
      groupId: rejected.groupId,
      contactId: rejected.contactId,
      actor: 'owner',
      eventType: 'approval.rejected',
      detail: { approvalId: id, ruleId: rejected.ruleId },
    });
    res.status(200).json({ approval: rejected });
  });

  return router;
}
