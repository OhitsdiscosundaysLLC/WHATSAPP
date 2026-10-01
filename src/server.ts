import express, { type NextFunction, type Request, type Response } from 'express';
import { getHealthReport } from './services/healthService';
import { createChildLogger } from './services/logger';

const log = createChildLogger('http');

export function createServer() {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json());

  app.get('/health', (_req: Request, res: Response) => {
    const report = getHealthReport();
    res.status(200).json(report);
  });

  // Placeholder root route — the real dashboard/API surface arrives in Phase 12.
  app.get('/', (_req: Request, res: Response) => {
    res.status(200).json({
      name: 'whatsapp-automation-bot',
      message: 'See /health for status.',
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
