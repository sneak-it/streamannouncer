import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

const dataDir = path.join(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(path.join(dataDir, 'bot.db'));
db.pragma('journal_mode = WAL'); // Enable Write-Ahead Logging for better concurrency and reliability

db.exec(`
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

/**
 * Creates a backup of the SQLite database using better-sqlite3's built-in backup method.
 * This method handles WAL mode correctly by creating a consistent snapshot without
 * needing to close the connection.
 * @param backupPath - The path where the backup file will be created.
 * @returns true if the backup was successful, false otherwise.
 */
export function createBackup(backupPath: string): boolean {
  try {
    db.backup(backupPath);
    return true;
  } catch (error) {
    console.error({ err: error }, 'Failed to create database backup');
    return false;
  }
}

/**
 * Gets the path to the most recent backup file in the data directory.
 * Returns null if no backups exist.
 */
export function getLatestBackupPath(): string | undefined {
  const backupFiles = fs.readdirSync(dataDir).filter(f => f.startsWith('bot-backup-') && f.endsWith('.db'));
  if (backupFiles.length === 0) return undefined;
  // Sort by name (which includes timestamp) to get the most recent
  const sorted = backupFiles.toSorted().toReversed();
  return path.join(dataDir, sorted[0]);
}

/**
 * Cleans up old backups, keeping only the most recent N backups.
 * @param maxKeep - The maximum number of backups to retain.
 */
export function cleanupOldBackups(maxKeep: number): void {
  const backupFiles = fs.readdirSync(dataDir).filter(f => f.startsWith('bot-backup-') && f.endsWith('.db'));
  if (backupFiles.length <= maxKeep) return; // Nothing to clean up

  // Sort by name (timestamp-based) and remove oldest first
  const sorted = backupFiles.toSorted();
  const toDelete = sorted.slice(0, sorted.length - maxKeep);
  for (const file of toDelete) {
    try {
      fs.unlinkSync(path.join(dataDir, file));
      console.log(`Deleted old backup: ${file}`);
    } catch (error) {
      console.error({ err: error }, `Failed to delete old backup: ${file}`);
    }
  }
}

/**
 * Creates a timestamped backup of the database and cleans up old backups.
 * @param maxKeep - The maximum number of backups to retain.
 * @returns true if the backup was successful, false otherwise.
 */
export function createTimestampedBackup(maxKeep: number = 5): boolean {
  const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const backupPath = path.join(dataDir, `bot-backup-${timestamp}.db`);
  const success = createBackup(backupPath);
  if (success) {
    cleanupOldBackups(maxKeep);
  }
  return success;
}

export function closeDb() {
  db.close();
}

export default db;
