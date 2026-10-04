import { promises as fs } from 'fs';
import path from 'path';
import express, { Router, type Request, type Response } from 'express';
import { attachSession } from './authMiddleware';

const PUBLIC_DIR = path.join(__dirname, 'public');
const VIEWS_DIR = path.join(__dirname, 'views');

/**
 * Serves the dashboard's static assets (CSS/JS/login page — no secrets in
 * any of them, safe to be publicly fetchable) and its authenticated HTML
 * pages. Each authenticated page requires a valid session; unlike the JSON
 * API's `requireAuth` (401), a browser navigation here redirects to
 * `/login` instead, since that's what a person clicking a link expects.
 */
export function createDashboardRouter(): Router {
  const router = Router();

  router.use(express.static(PUBLIC_DIR, { index: false }));

  router.get('/login', attachSession, (req: Request, res: Response) => {
    if (req.ownerSession) {
      res.redirect(302, '/');
      return;
    }
    res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
  });

  router.get('/', attachSession, async (req: Request, res: Response) => {
    if (!req.ownerSession) {
      res.redirect(302, '/login');
      return;
    }
    await sendTemplate(res, 'dashboard.html', { __CSRF_TOKEN__: req.ownerSession.csrfToken });
  });

  router.get('/groups', attachSession, async (req: Request, res: Response) => {
    if (!req.ownerSession) {
      res.redirect(302, '/login');
      return;
    }
    await sendTemplate(res, 'groups.html', { __CSRF_TOKEN__: req.ownerSession.csrfToken });
  });

  router.get('/groups/:id', attachSession, async (req: Request, res: Response) => {
    if (!req.ownerSession) {
      res.redirect(302, '/login');
      return;
    }
    const { id } = req.params as { id: string };
    await sendTemplate(res, 'group.html', {
      __CSRF_TOKEN__: req.ownerSession.csrfToken,
      __GROUP_ID__: id,
    });
  });

  router.get('/contacts', attachSession, async (req: Request, res: Response) => {
    if (!req.ownerSession) {
      res.redirect(302, '/login');
      return;
    }
    await sendTemplate(res, 'contacts.html', { __CSRF_TOKEN__: req.ownerSession.csrfToken });
  });

  router.get('/contacts/:id', attachSession, async (req: Request, res: Response) => {
    if (!req.ownerSession) {
      res.redirect(302, '/login');
      return;
    }
    const { id } = req.params as { id: string };
    await sendTemplate(res, 'contact.html', {
      __CSRF_TOKEN__: req.ownerSession.csrfToken,
      __CONTACT_ID__: id,
    });
  });

  router.get('/activity', attachSession, async (req: Request, res: Response) => {
    if (!req.ownerSession) {
      res.redirect(302, '/login');
      return;
    }
    await sendTemplate(res, 'activity.html', { __CSRF_TOKEN__: req.ownerSession.csrfToken });
  });

  router.get('/inbox', attachSession, async (req: Request, res: Response) => {
    if (!req.ownerSession) {
      res.redirect(302, '/login');
      return;
    }
    await sendTemplate(res, 'inbox.html', { __CSRF_TOKEN__: req.ownerSession.csrfToken });
  });

  router.get('/approvals', attachSession, async (req: Request, res: Response) => {
    if (!req.ownerSession) {
      res.redirect(302, '/login');
      return;
    }
    await sendTemplate(res, 'approvals.html', { __CSRF_TOKEN__: req.ownerSession.csrfToken });
  });

  router.get('/presets', attachSession, async (req: Request, res: Response) => {
    if (!req.ownerSession) {
      res.redirect(302, '/login');
      return;
    }
    await sendTemplate(res, 'presets.html', { __CSRF_TOKEN__: req.ownerSession.csrfToken });
  });

  router.get('/analytics', attachSession, async (req: Request, res: Response) => {
    if (!req.ownerSession) {
      res.redirect(302, '/login');
      return;
    }
    await sendTemplate(res, 'analytics.html', { __CSRF_TOKEN__: req.ownerSession.csrfToken });
  });

  router.get('/admins', attachSession, async (req: Request, res: Response) => {
    if (!req.ownerSession) {
      res.redirect(302, '/login');
      return;
    }
    await sendTemplate(res, 'admins.html', { __CSRF_TOKEN__: req.ownerSession.csrfToken });
  });

  router.get('/health', attachSession, async (req: Request, res: Response) => {
    if (!req.ownerSession) {
      res.redirect(302, '/login');
      return;
    }
    await sendTemplate(res, 'health.html', { __CSRF_TOKEN__: req.ownerSession.csrfToken });
  });

  return router;
}

async function sendTemplate(
  res: Response,
  templateName: string,
  replacements: Record<string, string>,
): Promise<void> {
  let html = await fs.readFile(path.join(VIEWS_DIR, templateName), 'utf8');
  for (const [placeholder, value] of Object.entries(replacements)) {
    html = html.split(placeholder).join(escapeHtmlAttr(value));
  }
  res.status(200).type('html').send(html);
}

/** `__GROUP_ID__` is a UUID from a route param, never arbitrary user text — this is defense in depth. */
function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
