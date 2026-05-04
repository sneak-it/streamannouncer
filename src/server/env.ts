/**
 * Environment variable validation for production readiness.
 * Ensures all required configuration is present before the bot starts.
 */

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
    const errorMessages = missingRequired.map(name => {
      const info = ENV_VARS.find(v => v.name === name);
      return `  - ${name}${info ? ` (${info.description})` : ''}`;
    });

    console.error('ERROR: Missing required environment variables:');
    console.error(errorMessages.join('\n'));
    console.error('\nPlease set these variables in your .env file or environment.');
    console.error('Copy .env.example to .env and fill in your credentials.');
    console.error('\nFor more information, see the README.md documentation.');

    throw new Error(`Missing ${missingRequired.length} required environment variable(s)`);
  }

  // Log warnings for optional variables
  if (warnings.length > 0) {
    console.warn('WARNING: Optional environment variables not set:');
    console.warn(warnings.join('\n'));
    console.warn('The bot will use default behavior for these settings.\n');
  }

  console.log('Environment validation passed. All required variables are set.');
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
