import { Router, type Request, type Response } from 'express';
import { AdminsRepository } from '../db/adminsRepository';
import { AuditRepository } from '../db/auditRepository';
import { getSupabaseClient, isSupabaseConfigured } from '../db/supabaseClient';
import { config } from '../config/config';
import { accountManager } from '../whatsapp/accountManager';
import { attachSession, requireAuth, requireCsrf } from './authMiddleware';

function requireSupabase(res: Response): boolean {
  if (!isSupabaseConfigured()) {
    res.status(503).json({
      error: 'supabase_not_configured',
      message: 'Admin management requires Supabase to be configured. See docs/DEPLOYMENT.md.',
    });
    return false;
  }
  return true;
}

/**
 * Admin/permission management (this hardening pass). The owner is always
 * exclusively `OWNER_WHATSAPP_NUMBERS` — read-only here, never editable
 * from the dashboard or any command, which is what makes privilege
 * escalation structurally impossible: nothing in this codebase can ever
 * write to that env var. Admins are a dashboard-manageable list
 * (`whatsapp_admins`), merged at authorization-check time with any
 * `ADMIN_WHATSAPP_NUMBERS` configured in the environment — see
 * src/whatsapp/commands/commandHandler.ts's `resolveAdminNumbers()`.
 */
export function createAdminRouter(): Router {
  const router = Router();
  router.use(attachSession, requireAuth);

  router.get('/', async (_req: Request, res: Response) => {
    const accounts = accountManager.listAccounts().map((a) => ({ id: a.id, label: a.label }));

    let dbAdmins: Awaited<ReturnType<AdminsRepository['listAll']>> = [];
    if (isSupabaseConfigured()) {
      const adminsRepository = new AdminsRepository(getSupabaseClient());
      dbAdmins = await adminsRepository.listAll();
    }

    res.status(200).json({
      owners: config.authorization.ownerNumbers,
      envAdmins: config.authorization.adminNumbers,
      dashboardAdmins: dbAdmins,
      accounts,
      supabaseConfigured: isSupabaseConfigured(),
    });
  });

  router.post('/', requireCsrf, async (req: Request, res: Response) => {
    if (!requireSupabase(res)) return;
    const body = req.body as { accountId?: unknown; phoneNumber?: unknown; label?: unknown };
    const accountId = typeof body.accountId === 'string' ? body.accountId : '';
    const phoneNumberRaw = typeof body.phoneNumber === 'string' ? body.phoneNumber : '';
    const phoneNumber = phoneNumberRaw.replace(/\D/g, '');
    const label = typeof body.label === 'string' ? body.label : undefined;

    if (!accountId || !phoneNumber) {
      res.status(400).json({
        error: 'invalid_admin',
        message: 'accountId and a digits-only phoneNumber are required.',
      });
      return;
    }

    const account = accountManager.listAccounts().find((a) => a.id === accountId);
    if (!account) {
      res.status(404).json({ error: 'account_not_found' });
      return;
    }

    const supabase = getSupabaseClient();
    const adminsRepository = new AdminsRepository(supabase);
    const admin = await adminsRepository.add(accountId, phoneNumber, label);

    const auditRepository = new AuditRepository(supabase);
    await auditRepository.recordEvent({
      accountId,
      groupId: undefined,
      actor: 'owner',
      eventType: 'admin.added',
      detail: { adminId: admin.id, phoneNumber },
    });

    res.status(201).json({ admin });
  });

  router.delete('/:id', requireCsrf, async (req: Request, res: Response) => {
    if (!requireSupabase(res)) return;
    const { id } = req.params as { id: string };
    const supabase = getSupabaseClient();
    const adminsRepository = new AdminsRepository(supabase);
    const existing = (await adminsRepository.listAll()).find((a) => a.id === id);
    if (!existing) {
      res.status(404).json({ error: 'admin_not_found' });
      return;
    }

    await adminsRepository.remove(id);

    const auditRepository = new AuditRepository(supabase);
    await auditRepository.recordEvent({
      accountId: existing.accountId,
      groupId: undefined,
      actor: 'owner',
      eventType: 'admin.removed',
      detail: { adminId: id, phoneNumber: existing.phoneNumber },
    });

    res.status(200).json({ ok: true });
  });

  return router;
}
