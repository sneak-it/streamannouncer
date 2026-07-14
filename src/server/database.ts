import fs from 'node:fs';
import path from 'node:path';

import { logger } from './logger.js';

import Database from 'better-sqlite3';

const dataDirectory = path.join(process.cwd(), 'data');

/**
 * Opens the SQLite database, ensuring the data directory and schema exist.
 */
function openDatabase(): Database.Database {
  if (!fs.existsSync(dataDirectory)) {
    fs.mkdirSync(dataDirectory, { recursive: true });
  }

  const database = new Database(path.join(dataDirectory, 'bot.db'));
  database.pragma('journal_mode = WAL'); // Enable Write-Ahead Logging for better concurrency and reliability

  database.exec(`
    CREATE TABLE IF NOT EXISTS tracked_users (
      discord_id TEXT PRIMARY KEY,
      twitch_username TEXT,
      twitch_id TEXT,
      added_at INTEGER,
      added_by TEXT
    );

    CREATE TABLE IF NOT EXISTS active_streams (
      twitch_id TEXT PRIMARY KEY,
      discord_id TEXT,
      message_id TEXT,
      channel_id TEXT,
      start_time INTEGER
    );
  `);

  return database;
}

const database = openDatabase();

/**
 * Creates a backup of the SQLite database using better-sqlite3's built-in backup method.
 * This method handles WAL mode correctly by creating a consistent snapshot without
 * needing to close the connection. The underlying `backup()` is asynchronous, so this
 * resolves only once the backup file is fully written.
 * @param backupPath - The path where the backup file will be created.
 * @throws If the backup could not be created.
 */
export async function createBackup(backupPath: string): Promise<void> {
  await database.backup(backupPath);
}

/**
 * Cleans up old backups, keeping only the most recent N backups.
 * @param maxKeep - The maximum number of backups to retain.
 */
export function cleanupOldBackups(maxKeep: number): void {
  // Defensive: a NaN/invalid limit would make `length <= maxKeep` false and
  // `slice(0, maxKeep)` empty, silently disabling pruning so backups pile up.
  const limit = Number.isSafeInteger(maxKeep) && maxKeep >= 0 ? maxKeep : 5;

  const backupFiles = fs.readdirSync(dataDirectory).filter(f => f.startsWith('bot-backup-') && f.endsWith('.db'));
  if (backupFiles.length <= limit) return; // Nothing to clean up

  // Sort by name (timestamp-based) and remove oldest first
  const sorted = backupFiles.toSorted((a, b) => a.localeCompare(b));
  const toDelete = sorted.slice(0, sorted.length - limit);
  for (const file of toDelete) {
    try {
      fs.unlinkSync(path.join(dataDirectory, file));
      logger.info({ file }, 'Deleted old backup');
    } catch (error) {
      logger.error({ err: error, file }, 'Failed to delete old backup');
    }
  }
}

/**
 * Creates a timestamped backup of the database and cleans up old backups.
 * @param maxKeep - The maximum number of backups to retain.
 * @throws If the backup could not be created.
 */
export async function createTimestampedBackup(maxKeep: number = 5): Promise<void> {
  const timestamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
  const backupPath = path.join(dataDirectory, `bot-backup-${timestamp}.db`);
  await createBackup(backupPath);
  cleanupOldBackups(maxKeep);
}

export function closeDatabase() {
  database.close();
}

export default database;
