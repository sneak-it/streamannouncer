import { startBot, stopBot } from './src/server/bot.js';
import { closeDb } from './src/server/db.js';
import { validateEnv } from './src/server/env.js';
import { logger } from './src/server/logger.js';

logger.info('Starting StreamAnnouncer bot...');

// Validate all required environment variables before starting
try {
  validateEnv();
} catch {
  logger.error('\nConfiguration error. Aborting startup.');
  process.exit(1);
}

startBot().catch(console.error);

// Graceful shutdown handling
const shutdown = async (signal: string) => {
  logger.info({ signal }, 'Received signal. Shutting down gracefully...');
  try {
    await stopBot();
    closeDb();
    logger.info('Shutdown complete.');
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, 'Error during shutdown');
    process.exit(1);
  }
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
