import type { ColorResolvable } from 'discord.js';

import { logger } from './logger.js';

import { resolveColor } from 'discord.js';

const DEFAULT_EMBED_COLOR = 0x91_46_FF; // Twitch purple

interface EnvironmentVariableInfo {
  name: string;
  required: boolean;
  description: string;
}

/**
List of all environment variables with their metadata.
*/
const ENV_VARS: EnvironmentVariableInfo[] = [
  { name: 'DISCORD_TOKEN', required: true, description: 'Discord bot token' },
  { name: 'DISCORD_GUILD_ID', required: true, description: 'Discord server (guild) ID' },
  { name: 'DISCORD_CHANNEL_ID', required: true, description: 'Discord channel ID for announcements' },
  { name: 'TWITCH_CLIENT_ID', required: true, description: 'Twitch API client ID' },
  { name: 'TWITCH_CLIENT_SECRET', required: true, description: 'Twitch API client secret' },
  { name: 'DISCORD_ROLE_ID', required: false, description: 'Discord role ID for streamer filtering (optional)' },
  { name: 'DISCORD_ADMIN_ROLE_ID', required: false, description: 'Discord admin role ID for command access (optional)' },
  { name: 'DISCORD_ANNOUNCEMENT_MESSAGE', required: false, description: 'Custom announcement message template (optional, uses default if not set)' },
  { name: 'EMBED_COLOR', required: false, description: 'Embed color as hex (e.g. 9146FF) or a discord.js color name (optional, defaults to Twitch purple)' },
  { name: 'TZ', required: false, description: 'Timezone for the container (optional, defaults to America/New_York)' },
  { name: 'POLL_INTERVAL_MINUTES', required: false, description: 'How often to poll Twitch for live streams in minutes (optional, defaults to 5)' },
  { name: 'BACKUP_ENABLED', required: false, description: 'Enable periodic database backups (optional, defaults to true)' },
  { name: 'BACKUP_INTERVAL_MINUTES', required: false, description: 'Interval between periodic backups in minutes (optional, defaults to 60)' },
  { name: 'BACKUP_MAX_KEEP', required: false, description: 'Maximum number of backups to keep (optional, defaults to 5)' },
];

/**
Parses an environment variable as a positive integer, falling back to a
default when unset or invalid. A malformed value (e.g. BACKUP_MAX_KEEP=five)
is logged and defaulted rather than silently coerced to NaN, which would
otherwise disable backup pruning or turn off backups entirely.
@param name - The environment variable name.
@param defaultValue - The value to use when unset or invalid.
*/
export function parsePositiveIntEnvironment(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return defaultValue;

  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    logger.warn({ name, value: raw, default: defaultValue }, 'Invalid numeric environment variable (expected a positive integer); using default');
    return defaultValue;
  }
  return parsed;
}

/**
Reads EMBED_COLOR (hex such as 9146FF or #9146FF, or a discord.js color name such
as Blurple or Random), falling back to Twitch purple when unset or invalid.
*/
export function parseEmbedColorEnvironment(): ColorResolvable {
  const raw = (process.env.EMBED_COLOR ?? '').trim();
  if (!raw) return DEFAULT_EMBED_COLOR;

  try {
    resolveColor(raw as ColorResolvable); // throws on an unrecognized color
  } catch {
    logger.warn({ name: 'EMBED_COLOR', value: raw, default: '9146FF' }, 'Invalid embed color (expected hex like 9146FF or a discord.js color name); using default');
    return DEFAULT_EMBED_COLOR;
  }
  // Keep the raw value rather than the resolved number so 'Random' re-rolls per embed.
  return raw as ColorResolvable;
}

/**
Validates that all required environment variables are set.
@throws {Error} If any required environment variable is missing or empty.
*/
export function validateEnvironment(): void {
  const missingRequired: string[] = [];
  const warnings: string[] = [];

  for (const environmentVariable of ENV_VARS) {
    const value = process.env[environmentVariable.name];

    if (!value || value.trim() === '') {
      if (environmentVariable.required) {
        missingRequired.push(environmentVariable.name);
      } else {
        warnings.push(`${environmentVariable.name} is not set (optional, using default behavior)`);
      }
    }
  }

  // Report errors for missing required variables
  if (missingRequired.length > 0) {
    logger.error({ missing: missingRequired }, 'Missing required environment variables');
    throw new Error(`Missing ${missingRequired.length} required environment variable(s)`);
  }

  // Log warnings for optional variables
  if (warnings.length > 0) {
    logger.warn({ warnings }, 'Optional environment variables not set');
  }

  logger.info('Environment validation passed. All required variables are set.');
}
