import { startBot, stopBot } from './src/server/bot.js';
import { closeDatabase } from './src/server/database.js';
import { validateEnvironment } from './src/server/environment.js';
import { logger } from './src/server/logger.js';

logger.info('Starting StreamAnnouncer bot...');

// Catch unhandled rejections/exceptions
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled promise rejection. Exiting.');
  process.exit(1);
});
process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'Uncaught exception. Exiting.');
  process.exit(1);
});

// Validate all required environment variables before starting
try {
  validateEnvironment();
} catch {
  logger.error('\nConfiguration error. Aborting startup.');
  process.exit(1);
}

try {
  await startBot();
} catch (error) {
  logger.error({ err: error }, 'Failed to start bot');
  process.exit(1);
}

// Graceful shutdown handling
const shutdown = async (signal: string) => {
  logger.info({ signal }, 'Received signal. Shutting down gracefully...');
  try {
    await stopBot();
    closeDatabase();
    logger.info('Shutdown complete.');
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, 'Error during shutdown');
    process.exit(1);
  }
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
