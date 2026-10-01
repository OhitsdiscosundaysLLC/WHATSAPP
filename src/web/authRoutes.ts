import { createHash, timingSafeEqual } from 'crypto';
import { Router, type Request, type Response } from 'express';
import { config } from '../config/config';
import { createChildLogger } from '../services/logger';
import { attachSession, SESSION_COOKIE_NAME, sessionCookieOptions } from './authMiddleware';
import { loginRateLimiter } from './loginRateLimiter';
import { sessionStore } from './sessionStore';

const log = createChildLogger('web:auth');

/** Constant-time comparison that also normalizes length, so differing input length doesn't leak via timing. */
function passwordsMatch(input: string, expected: string): boolean {
  const inputHash = createHash('sha256').update(input).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(inputHash, expectedHash);
}

function clientKey(req: Request): string {
  return req.ip ?? 'unknown';
}

export function createAuthRouter(): Router {
  const router = Router();

  router.post('/login', attachSession, (req: Request, res: Response) => {
    if (!config.dashboard.configured) {
      res.status(503).json({
        error: 'dashboard_not_configured',
        message: 'DASHBOARD_ADMIN_PASSWORD is not set — the dashboard is disabled until it is.',
      });
      return;
    }

    const key = clientKey(req);
    const rate = loginRateLimiter.isBlocked(key);
    if (rate.blocked) {
      res.status(429).json({
        error: 'too_many_attempts',
        retryAfterMs: rate.retryAfterMs,
      });
      return;
    }

    const body = req.body as { password?: unknown } | undefined;
    const password = typeof body?.password === 'string' ? body.password : '';

    if (!password || !passwordsMatch(password, config.dashboard.adminPassword!)) {
      loginRateLimiter.recordFailure(key);
      log.warn({ ip: key }, 'Failed dashboard login attempt');
      res.status(401).json({ error: 'invalid_password' });
      return;
    }

    loginRateLimiter.reset(key);
    const session = sessionStore.create();
    res.cookie(SESSION_COOKIE_NAME, session.id, sessionCookieOptions());
    log.info({ ip: key }, 'Dashboard login succeeded');
    res.status(200).json({ ok: true });
  });

  router.post('/logout', attachSession, (req: Request, res: Response) => {
    if (req.ownerSession) {
      sessionStore.destroy(req.ownerSession.id);
    }
    res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    res.status(200).json({ ok: true });
  });

  return router;
}
