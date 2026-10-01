import { config } from './config/config';
import { checkDatabaseHealth } from './db/supabaseClient';
import { logger } from './services/logger';
import { createServer } from './server';
import { accountManager } from './whatsapp/accountManager';

function main() {
  logger.info(
    {
      env: config.env,
      port: config.port,
      supabaseConfigured: config.supabase.configured,
      openaiConfigured: config.openai.configured,
      whatsappEnabled: config.whatsapp.enabled,
      dashboardConfigured: config.dashboard.configured,
      ownerCount: config.authorization.ownerNumbers.length,
      adminCount: config.authorization.adminNumbers.length,
    },
    'Starting WhatsApp automation bot (Phase 2B: web dashboard + pairing — no automation/AI yet)',
  );

  if (!config.dashboard.configured) {
    logger.warn(
      'DASHBOARD_ADMIN_PASSWORD is not set — the web dashboard will refuse all logins until it is configured.',
    );
  }

  const app = createServer({
    getWhatsAppStatus: () => accountManager.getAggregateStatus(),
    getDatabaseHealth: () => checkDatabaseHealth(),
    getAuthPersistence: () => accountManager.getStorageStatus(),
  });

  // Bind the HTTP server first (explicitly on all interfaces, as Render and
  // most PaaS hosts require) so health checks are available immediately,
  // then connect to WhatsApp in the background — a slow/failed WhatsApp
  // connection must never block or crash the HTTP server.
  const server = app.listen(config.port, '0.0.0.0', () => {
    logger.info({ port: config.port }, `HTTP server listening on port ${config.port}`);
  });

  if (config.whatsapp.enabled) {
    void accountManager.startAll();
  } else {
    // Still load the account registry (so the dashboard can list existing
    // accounts) — just skip actually connecting any of them.
    void accountManager.load();
    logger.info('WhatsApp integration disabled (WHATSAPP_ENABLED=false); skipping account startup');
  }

  let shuttingDown = false;

  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, 'Shutting down');

    // Stop accepting new WhatsApp connection attempts and close every
    // account's socket (without logging any of them out) before closing
    // the HTTP server, so an in-flight /health request still gets a response.
    accountManager
      .shutdownAll()
      .catch((err: unknown) => {
        logger.error({ err }, 'Error while stopping WhatsApp accounts during shutdown');
      })
      .finally(() => {
        server.close((err) => {
          if (err) {
            logger.error({ err }, 'Error during server shutdown');
            process.exit(1);
          }
          process.exit(0);
        });
      });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'Unhandled promise rejection');
  });

  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception');
    process.exit(1);
  });
}

main();
