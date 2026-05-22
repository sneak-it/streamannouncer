import { logger } from './logger.js';

interface EnvVarInfo {
  name: string;
  required: boolean;
  description: string;
}

/**
 * List of all environment variables with their metadata.
 */
const ENV_VARS: EnvVarInfo[] = [
  { name: 'DISCORD_TOKEN', required: true, description: 'Discord bot token' },
  { name: 'DISCORD_GUILD_ID', required: true, description: 'Discord server (guild) ID' },
  { name: 'DISCORD_CHANNEL_ID', required: true, description: 'Discord channel ID for announcements' },
  { name: 'TWITCH_CLIENT_ID', required: true, description: 'Twitch API client ID' },
  { name: 'TWITCH_CLIENT_SECRET', required: true, description: 'Twitch API client secret' },
  { name: 'DISCORD_ROLE_ID', required: false, description: 'Discord role ID for streamer filtering (optional)' },
  { name: 'DISCORD_ADMIN_ROLE_ID', required: false, description: 'Discord admin role ID for command access (optional)' },
  { name: 'DISCORD_ANNOUNCEMENT_MESSAGE', required: false, description: 'Custom announcement message template (optional, uses default if not set)' },
  { name: 'TZ', required: false, description: 'Timezone for the container (optional, defaults to America/New_York)' },
  { name: 'BACKUP_ENABLED', required: false, description: 'Enable periodic database backups (optional, defaults to true)' },
  { name: 'BACKUP_INTERVAL_MINUTES', required: false, description: 'Interval between periodic backups in minutes (optional, defaults to 60)' },
  { name: 'BACKUP_MAX_KEEP', required: false, description: 'Maximum number of backups to keep (optional, defaults to 5)' },
];

/**
 * Validates that all required environment variables are set.
 * @throws {Error} If any required environment variable is missing or empty.
 */
export function validateEnv(): void {
  const missingRequired: string[] = [];
  const warnings: string[] = [];

  for (const envVar of ENV_VARS) {
    const value = process.env[envVar.name];

    if (!value || value.trim() === '') {
      if (envVar.required) {
        missingRequired.push(envVar.name);
      } else {
        warnings.push(`${envVar.name} is not set (optional, using default behavior)`);
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

/**
 * Gets the value of an environment variable, or a default if not set.
 * @param name - The environment variable name.
 * @param defaultValue - The default value to use if the variable is not set.
 * @returns The environment variable value or the default.
 */
export function getEnvWithDefault(name: string, defaultValue: string): string {
  const value = process.env[name];
  return value && value.trim() !== '' ? value.trim() : defaultValue;
}
