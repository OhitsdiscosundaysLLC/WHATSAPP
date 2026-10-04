import { Router, type Request, type Response } from 'express';
import { AuditRepository } from '../db/auditRepository';
import {
  PRESET_SETTINGS_FIELDS,
  PresetsRepository,
  sanitizePresetSettings,
  type PresetSettings,
} from '../db/presetsRepository';
import { getSupabaseClient, isSupabaseConfigured } from '../db/supabaseClient';
import { attachSession, requireAuth, requireCsrf } from './authMiddleware';

function requireSupabase(res: Response): boolean {
  if (!isSupabaseConfigured()) {
    res.status(503).json({
      error: 'supabase_not_configured',
      message: 'Group Presets require Supabase to be configured. See docs/DEPLOYMENT.md.',
    });
    return false;
  }
  return true;
}

function bodySettings(body: unknown): PresetSettings {
  if (!body || typeof body !== 'object') return {};
  return sanitizePresetSettings(body as Record<string, unknown>);
}

/**
 * Named, reusable `group_settings` bundles — see src/db/presetsRepository.ts.
 * Account-scoped (a `group_presets` row belongs to exactly one WhatsApp
 * account), listed across all accounts by default — same single-owner
 * precedent as src/web/inboxRoutes.ts/activityRoutes.ts. Applying a preset
 * to a specific group is POST /api/groups/:id/apply-preset (see
 * groupRoutes.ts) — this router only manages the presets themselves.
 */
export function createPresetRouter(): Router {
  const router = Router();
  router.use(attachSession, requireAuth);

  router.get('/', async (req: Request, res: Response) => {
    if (!requireSupabase(res)) return;
    const { accountId } = req.query as { accountId?: string };
    const presetsRepository = new PresetsRepository(getSupabaseClient());

    if (accountId) {
      res.status(200).json({ presets: await presetsRepository.listByAccount(accountId) });
      return;
    }

    const { accountManager } = await import('../whatsapp/accountManager');
    const accounts = accountManager.listAccounts();
    const perAccount = await Promise.all(
      accounts.map((a) => presetsRepository.listByAccount(a.id)),
    );
    res.status(200).json({ presets: perAccount.flat() });
  });

  router.post('/', requireCsrf, async (req: Request, res: Response) => {
    if (!requireSupabase(res)) return;
    const body = req.body as
      { accountId?: unknown; name?: unknown; settings?: unknown } | undefined;
    const accountId = typeof body?.accountId === 'string' ? body.accountId : '';
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!accountId || !name) {
      res.status(400).json({
        error: 'invalid_request',
        message: 'accountId and name are required.',
      });
      return;
    }

    const presetsRepository = new PresetsRepository(getSupabaseClient());
    const preset = await presetsRepository.create(accountId, name, bodySettings(body?.settings));
    res.status(201).json({ preset });
  });

  router.patch('/:id', requireCsrf, async (req: Request, res: Response) => {
    if (!requireSupabase(res)) return;
    const { id } = req.params as { id: string };
    const supabase = getSupabaseClient();
    const presetsRepository = new PresetsRepository(supabase);
    const existing = await presetsRepository.getById(id);
    if (!existing) {
      res.status(404).json({ error: 'preset_not_found' });
      return;
    }

    const body = req.body as { name?: unknown; settings?: unknown } | undefined;
    const patch: { name?: string; settings?: PresetSettings } = {};
    if (typeof body?.name === 'string' && body.name.trim()) patch.name = body.name.trim();
    if (body?.settings !== undefined) patch.settings = bodySettings(body.settings);

    const preset = await presetsRepository.update(id, patch);
    res.status(200).json({ preset });
  });

  router.delete('/:id', requireCsrf, async (req: Request, res: Response) => {
    if (!requireSupabase(res)) return;
    const { id } = req.params as { id: string };
    const presetsRepository = new PresetsRepository(getSupabaseClient());
    const existing = await presetsRepository.getById(id);
    if (!existing) {
      res.status(404).json({ error: 'preset_not_found' });
      return;
    }
    await presetsRepository.remove(id);
    res.status(200).json({ ok: true });
  });

  router.post('/:id/duplicate', requireCsrf, async (req: Request, res: Response) => {
    if (!requireSupabase(res)) return;
    const { id } = req.params as { id: string };
    const supabase = getSupabaseClient();
    const presetsRepository = new PresetsRepository(supabase);
    const existing = await presetsRepository.getById(id);
    if (!existing) {
      res.status(404).json({ error: 'preset_not_found' });
      return;
    }

    const body = req.body as { name?: unknown } | undefined;
    const name =
      typeof body?.name === 'string' && body.name.trim()
        ? body.name.trim()
        : `${existing.name} (copy)`;

    const duplicate = await presetsRepository.duplicate(id, name);

    const auditRepository = new AuditRepository(supabase);
    await auditRepository.recordEvent({
      accountId: existing.accountId,
      groupId: undefined,
      actor: 'owner',
      eventType: 'preset.duplicated',
      detail: { sourcePresetId: id, newPresetId: duplicate.id, name },
    });

    res.status(201).json({ preset: duplicate });
  });

  router.get('/fields', (_req: Request, res: Response) => {
    res.status(200).json({ fields: PRESET_SETTINGS_FIELDS });
  });

  return router;
}
