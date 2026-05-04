import { startBot, stopBot } from './src/server/bot.js';
import { closeDb } from './src/server/db.js';
import { validateEnv } from './src/server/env.js';

console.log('Starting StreamAnnouncer bot...');

// Validate all required environment variables before starting
try {
  validateEnv();
} catch {
  console.error('\nConfiguration error. Aborting startup.');
  process.exit(1);
}

startBot().catch(console.error);

// Graceful shutdown handling
const shutdown = async (signal: string) => {
  console.log(`\nReceived ${signal}. Shutting down gracefully...`);
  try {
    await stopBot();
    closeDb();
    console.log('Shutdown complete.');
    process.exit(0);
  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
