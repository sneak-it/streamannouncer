# StreamAnnouncer Agent Instructions

This project is a Discord bot that announces Twitch streams.

## Technical Stack

- **Runtime**: Node.js 24+
- **Library**: `discord.js` v14
- **Database**: SQLite via `better-sqlite3` (stored in `./data/bot.db`)
- **API**: Twitch Helix API (requires Client ID and Secret)

## Architecture & Patterns

- **Environment Variables**: Managed via system env or `.env` file. Do NOT use `dotenv` package; use Node's native `--env-file` support.
- **Imports**: Must use explicit `.js` extensions for local module imports (e.g., `import db from './db.js'`).
- **Health Checks**: File-based heartbeat at `/tmp/healthy`. Created on `ClientReady`, removed on shutdown.
- **Polling**: Twitch streams are polled every 5 minutes.
- **Cleanup**: Announcement messages are automatically deleted when streams go offline.

## Database Schema

- `tracked_users`: `discord_id` (PK), `twitch_username`, `twitch_id`, `added_at`, `added_by`.
- `active_streams`: `twitch_id` (PK), `discord_id`, `message_id`, `channel_id`, `start_time`.

## Commands

- `/add-streamer`: Links Discord user to Twitch.
- `/remove-streamer`: Removes tracking by Discord user or Twitch name.
- `/list-streamers`: Lists all tracked users with metadata.
- `/test-embed`: Sends a test notification.

## Development Rules

- Always run `lint_applet` and `compile_applet` after changes.
- Maintain the `node:24-alpine` Dockerfile structure.
- Ensure `PermissionsBitField.Flags.Administrator` or `DISCORD_ADMIN_ROLE_ID` is checked for admin commands.
