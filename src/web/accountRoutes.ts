import { Router, type Request, type Response } from 'express';
import { accountManager } from '../whatsapp/accountManager';
import type { PairingSnapshot } from '../whatsapp/types';
import { createChildLogger } from '../services/logger';
import { attachSession, requireAuth, requireCsrf } from './authMiddleware';
import { toClientPairingSnapshot } from './qrImage';

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

  return router;
}
