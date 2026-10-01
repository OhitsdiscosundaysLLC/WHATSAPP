import { config } from './config/config';
import { logger } from './services/logger';
import { createServer } from './server';

function main() {
  logger.info(
    {
      env: config.env,
      port: config.port,
      supabaseConfigured: config.supabase.configured,
      openaiConfigured: config.openai.configured,
      ownerCount: config.authorization.ownerNumbers.length,
      adminCount: config.authorization.adminNumbers.length,
    },
    'Starting WhatsApp automation bot (Phase 1: foundation only — no WhatsApp/DB connection yet)',
  );

  const app = createServer();

  const server = app.listen(config.port, () => {
    logger.info({ port: config.port }, `HTTP server listening on port ${config.port}`);
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    server.close((err) => {
      if (err) {
        logger.error({ err }, 'Error during server shutdown');
        process.exit(1);
      }
      process.exit(0);
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
