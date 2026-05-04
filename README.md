# StreamAnnouncer Bot

A lightweight, Discord bot that automatically announces Twitch streams to a channel when particular users with a specific role go live.

## Features

- **Automatic Announcements**: Automatically detects when tracked users go live on Twitch.
- **Auto-Cleanup**: Deletes announcement messages when the stream ends.
- **Role-Based Tracking**: Only announces users who have a specific Discord role.
- **Admin Controls**: Restricted command for linking Discord users to Twitch accounts.
- **Docker Ready**: Runs as a small, unprivileged Alpine-based container.

## Prerequisites

- [Node.js 24+](https://nodejs.org/) (if running locally)
- [Docker](https://www.docker.com/) & [Docker Compose](https://docs.docker.com/compose/) (recommended)
- A [Discord Bot Token](https://discord.com/developers/applications)
- A [Twitch Developer Application](https://dev.twitch.tv/console) (Client ID & Secret)

## Discord Bot Setup (Permissions & Scopes)

When generating the invite link for your bot in the Discord Developer Portal (under **OAuth2 > URL Generator**), ensure you select the following:

**Scopes:**

- `bot`
- `applications.commands` (Required to register the `/add-streamer` slash command)

**Bot Permissions:**

- `View Channels` (To see the announcement channel)
- `Send Messages` (To post the stream announcements)
- `Embed Links` (To include the rich embed with the stream thumbnail and details)
- `Manage Messages` (To delete the announcement when the stream goes offline)
- `Read Message History` (To find and edit/delete previous announcements)

**Privileged Gateway Intents:**

In the **Bot** tab of the Discord Developer Portal, you must toggle the following intent to **ON**:

- `Server Members Intent` (Required to check which users have the specific Discord role)

## Quick Start (Docker)

1. **Clone the repository**:

   ```bash
   git clone https://github.com/sneak-it/streamannouncer.git
   cd streamannouncer
   ```

2. **Configure environment variables**:

   Copy `.env.example` to `.env` and fill in your credentials.

   ```bash
   cp .env.example .env
   ```

3. **Start the bot**:

   ```bash
   docker-compose up -d
   ```

## Configuration (.env)

| Variable | Description |
|----------|-------------|
| `DISCORD_TOKEN` | Your Discord Bot Token |
| `DISCORD_GUILD_ID` | The ID of your Discord Server |
| `DISCORD_ROLE_ID` | The ID of the role users must have to be announced |
| `DISCORD_ADMIN_ROLE_ID` | The ID of the role allowed to use `/add-streamer` |
| `DISCORD_CHANNEL_ID` | The ID of the channel where announcements are sent |
| `DISCORD_ANNOUNCEMENT_MESSAGE` | The message template. Supports `{user}` (Twitch name), `{mention}` (Discord mention), and `{url}` (Twitch URL). |
| `TWITCH_CLIENT_ID` | Your Twitch App Client ID |
| `TWITCH_CLIENT_SECRET` | Your Twitch App Client Secret |

## Commands

- `/add-streamer <user> <twitch_username>`: Links a Discord user to a Twitch account. (Requires Admin Role)
- `/remove-streamer [user] [username]`: Removes a linked streamer by their Discord user or Twitch username. (Requires Admin Role)
- `/list-streamers`: Lists all tracked streamers, including who added them and when. (Requires Admin Role)
- `/test-embed <username>`: Sends a test live notification to the configured channel for a specific Twitch user. (Requires Admin Role)

## Development

To run the bot locally without Docker:

```bash
npm install
npm run dev
```
