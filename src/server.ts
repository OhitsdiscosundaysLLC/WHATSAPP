import express, { type NextFunction, type Request, type Response } from 'express';
import { getHealthReport, getReadiness } from './services/healthService';
import { createChildLogger } from './services/logger';
import type { WhatsAppStatus } from './whatsapp/types';

const log = createChildLogger('http');

export interface ServerDeps {
  getWhatsAppStatus: () => WhatsAppStatus;
}

export function createServer({ getWhatsAppStatus }: ServerDeps) {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json());

  // Liveness: is the Node process itself up? Always 200 while the server is
  // running, even if WhatsApp is reconnecting — Render's health check
  // should point here, not at /ready (see docs/ARCHITECTURE.md).
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

  // Placeholder root route — the real dashboard/API surface arrives in Phase 12.
  app.get('/', (_req: Request, res: Response) => {
    res.status(200).json({
      name: 'whatsapp-automation-bot',
      message: 'See /health for status, /ready for readiness.',
    });
  });

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not_found' });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    log.error({ err }, 'Unhandled request error');
    res.status(500).json({ error: 'internal_server_error' });
  });

  return app;
}
