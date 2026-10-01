import cookieParser from 'cookie-parser';
import express, { type NextFunction, type Request, type Response } from 'express';
import { config } from './config/config';
import { getHealthReport, getReadiness } from './services/healthService';
import { createChildLogger } from './services/logger';
import { createAccountRouter } from './web/accountRoutes';
import { createAuthRouter } from './web/authRoutes';
import { createDashboardRouter } from './web/dashboardRoutes';
import type { WhatsAppStatus } from './whatsapp/types';

const log = createChildLogger('http');

export interface ServerDeps {
  getWhatsAppStatus: () => WhatsAppStatus;
}

export function createServer({ getWhatsAppStatus }: ServerDeps) {
  const app = express();

  app.disable('x-powered-by');

  if (config.isProduction) {
    // Render (and most PaaS hosts) terminate TLS at a reverse proxy and
    // forward plain HTTP internally. Without this, req.ip is the proxy's
    // address (breaking login rate limiting) and req.secure is always
    // false (breaking the `Secure` cookie flag's production detection).
    app.set('trust proxy', 1);
  }

  app.use(express.json());
  app.use(cookieParser());

  // Liveness: is the Node process itself up? Always 200 while the server is
  // running, even if WhatsApp is reconnecting — Render's health check
  // should point here, not at /ready (see docs/ARCHITECTURE.md). Public,
  // unauthenticated, and never includes QR/credentials — see docs/SECURITY.md.
  app.get('/health', (_req: Request, res: Response) => {
    const report = getHealthReport({ whatsapp: getWhatsAppStatus() });
    res.status(200).json(report);
  });

  // Readiness: is WhatsApp actually usable right now (or intentionally
  // disabled)? Returns 503 while awaiting QR / reconnecting / errored.
  app.get('/ready', (_req: Request, res: Response) => {
    const readiness = getReadiness(getWhatsAppStatus());
    res.status(readiness.ready ? 200 : 503).json(readiness);
  });

  // Owner login/logout (POST /login, POST /logout).
  app.use(createAuthRouter());

  // Dashboard pages + static assets (GET /login, GET /, /styles.css, ...).
  app.use(createDashboardRouter());

  // Authenticated WhatsApp account management API, including the QR/pairing
  // SSE stream. Never reachable without a valid owner session.
  app.use('/api/accounts', createAccountRouter());

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not_found' });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    log.error({ err }, 'Unhandled request error');
    res.status(500).json({ error: 'internal_server_error' });
  });

  return app;
}
