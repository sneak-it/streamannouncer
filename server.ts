import { startBot, stopBot } from './src/server/bot.js';
import { closeDb } from './src/server/db.js';

console.log('Starting StreamAnnouncer bot...');
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
