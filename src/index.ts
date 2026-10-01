import { config } from './config/config';
import { logger } from './services/logger';
import { createServer } from './server';
import { getWhatsAppStatus, startWhatsApp, stopWhatsApp } from './whatsapp/whatsappService';

function main() {
  logger.info(
    {
      env: config.env,
      port: config.port,
      supabaseConfigured: config.supabase.configured,
      openaiConfigured: config.openai.configured,
      whatsappEnabled: config.whatsapp.enabled,
      ownerCount: config.authorization.ownerNumbers.length,
      adminCount: config.authorization.adminNumbers.length,
    },
    'Starting WhatsApp automation bot (Phase 2: connection/session foundation — no automation/AI yet)',
  );

  const app = createServer({ getWhatsAppStatus });

  // Bind the HTTP server first so health checks are available immediately,
  // then connect to WhatsApp in the background — a slow/failed WhatsApp
  // connection must never block or crash the HTTP server.
  const server = app.listen(config.port, () => {
    logger.info({ port: config.port }, `HTTP server listening on port ${config.port}`);
  });

  void startWhatsApp();

  let shuttingDown = false;

  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, 'Shutting down');

    // Stop accepting new WhatsApp connection attempts and close the socket
    // (without logging out the linked device) before closing the HTTP
    // server, so an in-flight /health request still gets a response.
    stopWhatsApp()
      .catch((err: unknown) => {
        logger.error({ err }, 'Error while stopping WhatsApp connection during shutdown');
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
