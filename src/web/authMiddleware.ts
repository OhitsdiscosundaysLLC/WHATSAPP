import type { CookieOptions, NextFunction, Request, Response } from 'express';
import { config } from '../config/config';
import { type SessionRecord, sessionStore } from './sessionStore';

export const SESSION_COOKIE_NAME = 'wa_owner_session';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by `attachSession` when a valid, non-expired session cookie is present. */
      ownerSession?: SessionRecord;
    }
  }
}

export function sessionCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'lax',
    path: '/',
    maxAge: sessionStore.ttl,
  };
}

/** Reads the session cookie (if any) and attaches the session record to `req`. Never rejects. */
export function attachSession(req: Request, _res: Response, next: NextFunction): void {
  const cookieValue = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE_NAME];
  if (cookieValue) {
    const session = sessionStore.get(cookieValue);
    if (session) {
      req.ownerSession = session;
    }
  }
  next();
}

/** Must run after `attachSession`. Rejects with 401 if there's no valid session. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.ownerSession) {
    res.status(401).json({ error: 'authentication_required' });
    return;
  }
  next();
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Must run after `attachSession`/`requireAuth`. Synchronizer-token CSRF
 * check for state-changing requests: the token is minted per-session at
 * login and must be echoed back in the `X-CSRF-Token` header. SameSite=Lax
 * on the session cookie already blocks most cross-site state changes; this
 * is defense in depth on top of that (see docs/SECURITY.md).
 */
export function requireCsrf(req: Request, res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }
  const header = req.get('X-CSRF-Token');
  if (!req.ownerSession || !header || header !== req.ownerSession.csrfToken) {
    res.status(403).json({ error: 'csrf_check_failed' });
    return;
  }
  next();
}
