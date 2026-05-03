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

export function closeDb() {
  db.close();
}

export default db;
