import { Router, type Request, type Response } from 'express';
import {
  AccountSettingsRepository,
  DAILY_SUMMARY_DELIVERIES,
  type CallResponseAction,
  type DailySummaryDelivery,
} from '../db/accountSettingsRepository';
import { getSupabaseClient, isSupabaseConfigured } from '../db/supabaseClient';
import { computeAnalytics } from '../services/analytics';
import { computeDailySummary, DAILY_SUMMARY_METRIC_IDS } from '../services/dailySummary';
import { accountManager } from '../whatsapp/accountManager';
import type { PairingSnapshot } from '../whatsapp/types';
import { createChildLogger } from '../services/logger';
import { attachSession, requireAuth, requireCsrf } from './authMiddleware';
import { toClientPairingSnapshot } from './qrImage';

const CALL_RESPONSE_ACTIONS: CallResponseAction[] = [
  'LOG_ONLY',
  'NOTIFY_OWNER',
  'AUTO_REJECT',
  'SEND_MESSAGE_AFTER',
];

const log = createChildLogger('web:accounts');

const HEARTBEAT_MS = 20_000;
const PHONE_NUMBER_PATTERN = /^[1-9]\d{6,14}$/; // digits only, no leading '+', no leading 0

export function createAccountRouter(): Router {
  const router = Router();

  router.use(attachSession, requireAuth);

  router.get('/', (_req: Request, res: Response) => {
    res.status(200).json({ accounts: accountManager.listAccounts() });
  });

  router.post('/', requireCsrf, async (req: Request, res: Response) => {
    const body = req.body as { label?: unknown } | undefined;
    const label = typeof body?.label === 'string' ? body.label : '';
    const account = await accountManager.createAccount(label);
    res.status(201).json({ account });
  });

  router.get('/:id/events', (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    if (!accountManager.hasAccount(id)) {
      res.status(404).json({ error: 'account_not_found' });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Hint to any buffering reverse proxy in front of this app not to
      // delay delivery — harmless if the proxy doesn't recognize it.
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    let destroyed = false;
    const send = (snapshot: PairingSnapshot) => {
      toClientPairingSnapshot(snapshot)
        .then((payload) => {
          if (!destroyed) res.write(`event: status\ndata: ${JSON.stringify(payload)}\n\n`);
        })
        .catch((err: unknown) =>
          log.warn({ err, accountId: id }, 'Failed to render QR for dashboard'),
        );
    };

    const initial = accountManager.getPairingSnapshot(id);
    if (initial) send(initial);

    const unsubscribe = accountManager.onAccountUpdate(id, send);

    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    req.on('close', () => {
      destroyed = true;
      clearInterval(heartbeat);
      unsubscribe?.();
    });
  });

  router.post('/:id/pairing-code', requireCsrf, async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    if (!accountManager.hasAccount(id)) {
      res.status(404).json({ error: 'account_not_found' });
      return;
    }

    const body = req.body as { phoneNumber?: unknown } | undefined;
    const phoneNumber = typeof body?.phoneNumber === 'string' ? body.phoneNumber.trim() : '';
    if (!PHONE_NUMBER_PATTERN.test(phoneNumber)) {
      res.status(400).json({
        error: 'invalid_phone_number',
        message: 'Use digits only, country code first, no leading "+" or "0" (e.g. 15551234567).',
      });
      return;
    }

    try {
      const code = await accountManager.requestPairingCode(id, phoneNumber);
      res.status(200).json({ code, phoneNumber });
    } catch (err) {
      log.warn({ err, accountId: id }, 'Failed to request WhatsApp pairing code');
      res.status(409).json({
        error: 'pairing_code_unavailable',
        message:
          'Could not request a pairing code right now — try again once the account is awaiting QR.',
      });
    }
  });

  router.post('/:id/reconnect', requireCsrf, async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    const account = await accountManager.reconnectAccount(id);
    if (!account) {
      res.status(404).json({ error: 'account_not_found' });
      return;
    }
    res.status(200).json({ account });
  });

  router.post('/:id/disconnect', requireCsrf, async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    const account = await accountManager.disconnectAccount(id);
    if (!account) {
      res.status(404).json({ error: 'account_not_found' });
      return;
    }
    res.status(200).json({ account });
  });

  router.delete('/:id', requireCsrf, async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    const removed = await accountManager.removeAccount(id);
    if (!removed) {
      res.status(404).json({ error: 'account_not_found' });
      return;
    }
    res.status(200).json({ ok: true });
  });

  // Call handling is configured per WhatsApp ACCOUNT, not per group — see
  // src/db/accountSettingsRepository.ts's doc comment for why.
  router.get('/:id/call-settings', async (req: Request, res: Response) => {
    if (!isSupabaseConfigured()) {
      res.status(503).json({
        error: 'supabase_not_configured',
        message: 'Call handling requires Supabase to be configured.',
      });
      return;
    }
    const { id } = req.params as { id: string };
    if (!accountManager.hasAccount(id)) {
      res.status(404).json({ error: 'account_not_found' });
      return;
    }
    const repository = new AccountSettingsRepository(getSupabaseClient());
    const settings = await repository.ensure(id);
    res.status(200).json({ settings });
  });

  router.patch('/:id/call-settings', requireCsrf, async (req: Request, res: Response) => {
    if (!isSupabaseConfigured()) {
      res.status(503).json({
        error: 'supabase_not_configured',
        message: 'Call handling requires Supabase to be configured.',
      });
      return;
    }
    const { id } = req.params as { id: string };
    if (!accountManager.hasAccount(id)) {
      res.status(404).json({ error: 'account_not_found' });
      return;
    }

    const body = req.body as
      | {
          callHandlingEnabled?: unknown;
          callResponseAction?: unknown;
          callResponseMessage?: unknown;
          automationPaused?: unknown;
        }
      | undefined;
    const patch: Parameters<AccountSettingsRepository['update']>[1] = {};
    if (typeof body?.callHandlingEnabled === 'boolean') {
      patch.callHandlingEnabled = body.callHandlingEnabled;
    }
    if (
      typeof body?.callResponseAction === 'string' &&
      CALL_RESPONSE_ACTIONS.includes(body.callResponseAction as CallResponseAction)
    ) {
      patch.callResponseAction = body.callResponseAction as CallResponseAction;
    }
    if (typeof body?.callResponseMessage === 'string') {
      patch.callResponseMessage = body.callResponseMessage;
    }
    if (typeof body?.automationPaused === 'boolean') {
      patch.automationPaused = body.automationPaused;
    }

    const repository = new AccountSettingsRepository(getSupabaseClient());
    const settings = await repository.update(id, patch);
    res.status(200).json({ settings });
  });

  // Daily Owner Summary — see src/services/dailySummary.ts.
  router.get('/:id/daily-summary-settings', async (req: Request, res: Response) => {
    if (!isSupabaseConfigured()) {
      res.status(503).json({
        error: 'supabase_not_configured',
        message: 'The Daily Owner Summary requires Supabase to be configured.',
      });
      return;
    }
    const { id } = req.params as { id: string };
    if (!accountManager.hasAccount(id)) {
      res.status(404).json({ error: 'account_not_found' });
      return;
    }
    const repository = new AccountSettingsRepository(getSupabaseClient());
    const settings = await repository.ensure(id);
    res.status(200).json({ settings, availableMetrics: DAILY_SUMMARY_METRIC_IDS });
  });

  router.patch('/:id/daily-summary-settings', requireCsrf, async (req: Request, res: Response) => {
    if (!isSupabaseConfigured()) {
      res.status(503).json({
        error: 'supabase_not_configured',
        message: 'The Daily Owner Summary requires Supabase to be configured.',
      });
      return;
    }
    const { id } = req.params as { id: string };
    if (!accountManager.hasAccount(id)) {
      res.status(404).json({ error: 'account_not_found' });
      return;
    }

    const body = req.body as
      | {
          dailySummaryEnabled?: unknown;
          dailySummaryTimeMinutes?: unknown;
          dailySummaryTimezone?: unknown;
          dailySummaryDelivery?: unknown;
          dailySummaryMetrics?: unknown;
        }
      | undefined;
    const patch: Parameters<AccountSettingsRepository['update']>[1] = {};
    if (typeof body?.dailySummaryEnabled === 'boolean') {
      patch.dailySummaryEnabled = body.dailySummaryEnabled;
    }
    if (
      typeof body?.dailySummaryTimeMinutes === 'number' &&
      Number.isInteger(body.dailySummaryTimeMinutes) &&
      body.dailySummaryTimeMinutes >= 0 &&
      body.dailySummaryTimeMinutes < 1440
    ) {
      patch.dailySummaryTimeMinutes = body.dailySummaryTimeMinutes;
    }
    if (typeof body?.dailySummaryTimezone === 'string' && body.dailySummaryTimezone.trim()) {
      patch.dailySummaryTimezone = body.dailySummaryTimezone.trim();
    }
    if (
      typeof body?.dailySummaryDelivery === 'string' &&
      DAILY_SUMMARY_DELIVERIES.includes(body.dailySummaryDelivery as DailySummaryDelivery)
    ) {
      patch.dailySummaryDelivery = body.dailySummaryDelivery as DailySummaryDelivery;
    }
    if (Array.isArray(body?.dailySummaryMetrics)) {
      patch.dailySummaryMetrics = body.dailySummaryMetrics.filter(
        (m): m is string => typeof m === 'string' && DAILY_SUMMARY_METRIC_IDS.includes(m),
      );
    }

    const repository = new AccountSettingsRepository(getSupabaseClient());
    const settings = await repository.update(id, patch);
    res.status(200).json({ settings });
  });

  /** A live preview of today-so-far's summary — never marks anything sent, never dispatches via WhatsApp. */
  router.get('/:id/daily-summary-preview', async (req: Request, res: Response) => {
    if (!isSupabaseConfigured()) {
      res.status(503).json({
        error: 'supabase_not_configured',
        message: 'The Daily Owner Summary requires Supabase to be configured.',
      });
      return;
    }
    const { id } = req.params as { id: string };
    if (!accountManager.hasAccount(id)) {
      res.status(404).json({ error: 'account_not_found' });
      return;
    }
    const supabase = getSupabaseClient();
    const repository = new AccountSettingsRepository(supabase);
    const settings = await repository.ensure(id);
    const result = await computeDailySummary(
      supabase,
      id,
      settings.dailySummaryMetrics,
      settings.dailySummaryTimezone,
    );
    res.status(200).json(result);
  });

  // Analytics — real aggregated data only, over a selectable range. See
  // src/services/analytics.ts.
  router.get('/:id/analytics', async (req: Request, res: Response) => {
    if (!isSupabaseConfigured()) {
      res.status(503).json({
        error: 'supabase_not_configured',
        message: 'Analytics requires Supabase to be configured.',
      });
      return;
    }
    const { id } = req.params as { id: string };
    if (!accountManager.hasAccount(id)) {
      res.status(404).json({ error: 'account_not_found' });
      return;
    }

    const query = req.query as { rangeDays?: string };
    const allowedRangeDays = [7, 30, 90];
    const rangeDays = allowedRangeDays.includes(Number(query.rangeDays))
      ? Number(query.rangeDays)
      : 7;

    const rangeEnd = new Date();
    const rangeStart = new Date(rangeEnd.getTime() - rangeDays * 24 * 60 * 60 * 1000);
    const result = await computeAnalytics(getSupabaseClient(), id, rangeStart, rangeEnd);
    res.status(200).json(result);
  });

  return router;
}
