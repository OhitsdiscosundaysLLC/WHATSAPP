import { Router, type Request, type Response } from 'express';
import { AuditRepository } from '../db/auditRepository';
import { getSupabaseClient, isSupabaseConfigured } from '../db/supabaseClient';
import { buildBackupDocument } from '../services/backupExport';
import {
  applyBackupImport,
  planBackupImport,
  validateBackupDocument,
} from '../services/backupImport';
import { accountManager } from '../whatsapp/accountManager';
import { attachSession, requireAuth, requireCsrf } from './authMiddleware';

function requireSupabase(res: Response): boolean {
  if (!isSupabaseConfigured()) {
    res.status(503).json({
      error: 'supabase_not_configured',
      message: 'Backup/Export requires Supabase to be configured. See docs/DEPLOYMENT.md.',
    });
    return false;
  }
  return true;
}

/**
 * Exports/imports non-secret configuration (account settings, group/contact
 * settings + rules, presets) for backup and migration between accounts.
 * Never touches `whatsapp_accounts`/`auth_credentials`/`auth_keys` (the
 * WhatsApp session itself), API keys, the encryption key, the dashboard
 * password, or session secrets — those tables are never read by
 * src/services/backupExport.ts, and src/services/backupImport.ts never
 * writes to them either. See docs/SECURITY.md.
 */
export function createBackupRouter(): Router {
  const router = Router();
  router.use(attachSession, requireAuth);

  router.get('/export', async (req: Request, res: Response) => {
    if (!requireSupabase(res)) return;
    const { accountId } = req.query as { accountId?: string };
    if (!accountId || !accountManager.hasAccount(accountId)) {
      res.status(404).json({ error: 'account_not_found' });
      return;
    }

    const account = accountManager.listAccounts().find((a) => a.id === accountId);
    const supabase = getSupabaseClient();
    const document = await buildBackupDocument(supabase, accountId, account?.label ?? accountId);

    const auditRepository = new AuditRepository(supabase);
    await auditRepository.recordEvent({
      accountId,
      groupId: undefined,
      actor: 'owner',
      eventType: 'backup.exported',
      detail: {
        groupCount: document.groups.length,
        contactCount: document.contacts.length,
        presetCount: document.presets.length,
      },
    });

    res.status(200).json({ document });
  });

  router.post('/import/preview', requireCsrf, async (req: Request, res: Response) => {
    if (!requireSupabase(res)) return;
    const body = req.body as { targetAccountId?: unknown; document?: unknown } | undefined;
    const targetAccountId = typeof body?.targetAccountId === 'string' ? body.targetAccountId : '';
    if (!targetAccountId || !accountManager.hasAccount(targetAccountId)) {
      res.status(404).json({ error: 'account_not_found' });
      return;
    }

    const validation = validateBackupDocument(body?.document);
    if (!validation.valid) {
      res.status(400).json({ error: 'invalid_backup_document', message: validation.error });
      return;
    }

    const plan = await planBackupImport(getSupabaseClient(), targetAccountId, validation.document);
    res.status(200).json({ plan });
  });

  router.post('/import/apply', requireCsrf, async (req: Request, res: Response) => {
    if (!requireSupabase(res)) return;
    const body = req.body as { targetAccountId?: unknown; document?: unknown } | undefined;
    const targetAccountId = typeof body?.targetAccountId === 'string' ? body.targetAccountId : '';
    if (!targetAccountId || !accountManager.hasAccount(targetAccountId)) {
      res.status(404).json({ error: 'account_not_found' });
      return;
    }

    const validation = validateBackupDocument(body?.document);
    if (!validation.valid) {
      res.status(400).json({ error: 'invalid_backup_document', message: validation.error });
      return;
    }

    const result = await applyBackupImport(
      getSupabaseClient(),
      targetAccountId,
      validation.document,
    );
    res.status(200).json({ result });
  });

  return router;
}
