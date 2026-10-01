import { promises as fs } from 'fs';
import path from 'path';
import express, { Router, type Request, type Response } from 'express';
import { attachSession } from './authMiddleware';

const PUBLIC_DIR = path.join(__dirname, 'public');
const DASHBOARD_TEMPLATE_PATH = path.join(__dirname, 'views', 'dashboard.html');

/**
 * Serves the dashboard's static assets (CSS/JS/login page — no secrets in
 * any of them, safe to be publicly fetchable) and the two HTML entry
 * points. `GET /` is the one page that requires a valid session; unlike
 * the JSON API's `requireAuth` (401), a browser navigation here redirects
 * to `/login` instead, since that's what a person clicking a link expects.
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
    const template = await fs.readFile(DASHBOARD_TEMPLATE_PATH, 'utf8');
    const html = template.replace('__CSRF_TOKEN__', req.ownerSession.csrfToken);
    res.status(200).type('html').send(html);
  });

  return router;
}
