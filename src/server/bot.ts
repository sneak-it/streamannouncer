import type { TwitchStream, TwitchUser } from './twitch.js';
import type { ButtonInteraction, ChatInputCommandInteraction, Interaction, TextChannel } from 'discord.js';

import fs from 'node:fs';

import database, { createTimestampedBackup } from './database.js';
import { logger } from './logger.js';
import { clearTwitchToken, getStreamsByIds, getUsers, getUsersByIds, TwitchApiError } from './twitch.js';

import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, EmbedBuilder, Events,
  GatewayIntentBits, InteractionContextType, MessageFlags, PermissionsBitField,
  REST, Routes, SlashCommandBuilder
} from 'discord.js';


interface TrackedUser {
  discord_id: string;
  twitch_username: string;
  twitch_id: string;
  added_at: number;
  added_by: string;
}

interface ActiveStream {
  twitch_id: string;
  discord_id: string;
  message_id: string;
  channel_id: string;
  start_time: number;
}

// Constants
const HEALTH_FILE = '/tmp/healthy';
const USER_PROFILE_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
const USER_PROFILE_CACHE_MAX_SIZE = 1000;

// Mutable bot state. Held in a single object so module-level bindings are never
// reassigned from inside functions (unicorn/no-top-level-assignment-in-function).
const botState: {
  // Polling with Promise-based locking to prevent race conditions
  isPolling: boolean;
  pollLock: Promise<void>;
  // Polling timer reference for cleanup on shutdown
  pollIntervalId: ReturnType<typeof setInterval> | undefined;
  // Periodic backup timer reference for cleanup on shutdown
  backupIntervalId: ReturnType<typeof setInterval> | undefined;
  // Whether the Discord client has reached the ready state
  isReady: boolean;
} = {
  isPolling: false,
  pollLock: Promise.resolve(),
  pollIntervalId: undefined,
  backupIntervalId: undefined,
  isReady: false,
};

// User profile cache with LRU eviction
interface UserProfileCacheEntry {
  profile: TwitchUser;
  timestamp: number;
}
const userProfileCache = new Map<string, UserProfileCacheEntry>();

// State for paginated /list-streamers button interactions
interface ListStreamersState {
  users: TrackedUser[];
  currentPage: number;
  userId: string;
}
const listStreamersState = new Map<string, ListStreamersState>();

// Pre-compiled database statements to reduce GC pressure
const selectAllTrackedUsersStatement = database.prepare('SELECT * FROM tracked_users ORDER BY added_at ASC');
const upsertTrackedUserStatement = database.prepare(`
  INSERT INTO tracked_users (discord_id, twitch_username, twitch_id, added_at, added_by)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(discord_id) DO UPDATE SET
    twitch_username = excluded.twitch_username,
    twitch_id = excluded.twitch_id,
    added_at = excluded.added_at,
    added_by = excluded.added_by
`);
const deleteTrackedUserByDiscordIdStatement = database.prepare('DELETE FROM tracked_users WHERE discord_id = ?');
const deleteTrackedUserByTwitchUsernameStatement = database.prepare('DELETE FROM tracked_users WHERE twitch_username = ?');
const selectAllActiveStreamsStatement = database.prepare('SELECT * FROM active_streams');
const deleteActiveStreamByTwitchIdStatement = database.prepare('DELETE FROM active_streams WHERE twitch_id = ?');
const updateTrackedUserTwitchUsernameStatement = database.prepare('UPDATE tracked_users SET twitch_username = ? WHERE twitch_id = ?');
const insertActiveStreamStatement = database.prepare(`
  INSERT INTO active_streams (twitch_id, discord_id, message_id, channel_id, start_time)
  VALUES (?, ?, ?, ?, ?)
`);

/**
 * Evicts the least recently used entry from the cache when full.
 */
function evictLeastRecentlyUsed(): void {
  if (userProfileCache.size === 0) {
  	return;
  }

  // The first entry in a Map is the oldest (insertion order)
  const firstKey = userProfileCache.keys().next().value;
  if (firstKey !== undefined) {
    userProfileCache.delete(firstKey);
  }
}

/**
 * Gets a user profile from cache or fetches it from Twitch API.
 * Uses LRU eviction when cache reaches max size.
 */
async function getUserProfile(userId: string): Promise<TwitchUser | undefined> {
  const cached = userProfileCache.get(userId);
  if (cached && Date.now() - cached.timestamp < USER_PROFILE_CACHE_TTL) {
    return cached.profile;
  }
  
  try {
    const users = await getUsersByIds([userId]);
    if (users.length > 0) {
      // Evict expired entry before setting new one
      if (cached) userProfileCache.delete(userId);
      // Enforce max size with LRU eviction
      while (userProfileCache.size >= USER_PROFILE_CACHE_MAX_SIZE) {
        evictLeastRecentlyUsed();
      }
      userProfileCache.set(userId, {
        profile: users[0],
        timestamp: Date.now()
      });
      return users[0];
    }
  } catch (error) {
    logger.error({ err: error, user_id: userId }, 'Failed to get user profile');
  }
  
  // Clean up expired entry on cache miss
  if (cached && Date.now() - cached.timestamp >= USER_PROFILE_CACHE_TTL) {
    userProfileCache.delete(userId);
  }
  
  return undefined;
}

/**
 * Formats stream duration into a human-readable string.
 */
function formatStreamDuration(startedAt: string): string {
  const start = new Date(startedAt).getTime();
  const now = Date.now();
  const diff = Math.floor((now - start) / 1000);

  const hours = Math.floor(diff / 3600);
  const minutes = Math.floor((diff % 3600) / 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

/**
 * Builds a rich embed for a live Twitch stream announcement.
 */
function buildStreamEmbed(
  stream: {
    user_id: string;
    user_login: string;
    user_name: string;
    title: string;
    game_name: string;
    viewer_count: number;
    thumbnail_url: string;
    started_at: string;
  },
  profile?: TwitchUser,
): EmbedBuilder {
  const thumbnailCacheBuster = Math.floor(Date.now() / (20 * 60 * 1000));
  const thumbnailUrl = stream.thumbnail_url
    .replace('{width}', '400')
    .replace('{height}', '225')
    + `?t=${thumbnailCacheBuster}`;

  const embed = new EmbedBuilder()
    .setColor('#9146FF')
    .setTitle(stream.title || 'Untitled Stream')
    .setURL(`https://twitch.tv/${stream.user_login}`)
    .setAuthor({
      name: stream.user_name,
      iconURL: profile?.profile_image_url,
      url: `https://twitch.tv/${stream.user_login}`,
    })
    .setDescription(
      `🟢 **LIVE** now playing **${stream.game_name || 'Just Chatting'}**`,
    );

  // Thumbnail (small avatar in top-right)
  if (profile?.profile_image_url) {
    embed.setThumbnail(profile.profile_image_url);
  }

  embed.addFields(
    { name: '\u{1F3AE} Game', value: stream.game_name || 'Just Chatting', inline: true },
    { name: '\u{1F441} Viewers', value: stream.viewer_count.toLocaleString(), inline: true },
    { name: '\u{23F1} Duration', value: formatStreamDuration(stream.started_at), inline: true },
  );

  // Full-size image (compact preview, clickable to expand)
  embed.setImage(thumbnailUrl);

  // Footer with native Discord timestamp — renders "Last Updated  Today at 4:03pm"
  embed.setFooter({ text: 'Last Updated' });
  embed.setTimestamp();
  return embed;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
  ]
});

export function isBotReady() {
  return botState.isReady;
}

const commands = [
  new SlashCommandBuilder()
    .setName('add-streamer')
    .setDescription('Link a Twitch username to a Discord user')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
    .setContexts(InteractionContextType.Guild)
    .addUserOption(option =>
      option.setName('user')
        .setDescription('The Discord user to link')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('username')
        .setDescription('Their Twitch username')
        .setRequired(true)),
  new SlashCommandBuilder()
    .setName('remove-streamer')
    .setDescription('Remove a linked streamer')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
    .setContexts(InteractionContextType.Guild)
    .addUserOption(option =>
      option.setName('user')
        .setDescription('The Discord user to remove')
        .setRequired(false))
    .addStringOption(option =>
      option.setName('username')
        .setDescription('The Twitch username to remove')
        .setRequired(false)),
  new SlashCommandBuilder()
    .setName('list-streamers')
    .setDescription('List all tracked streamers')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
    .setContexts(InteractionContextType.Guild),
  new SlashCommandBuilder()
    .setName('test-embed')
    .setDescription('Send a test live notification')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
    .setContexts(InteractionContextType.Guild)
    .addStringOption(option =>
      option.setName('username')
        .setDescription('The Twitch username to test with')
        .setRequired(true)),
].map(command => command.toJSON());

const botLogger = logger.child({ name: 'bot' });

const handleClientReady = async (): Promise<void> => {
  botLogger.info({ username: client.user?.tag }, 'Bot logged in');
  botState.isReady = true;

  // Create health file for Docker healthcheck
  try {
    fs.writeFileSync(HEALTH_FILE, 'ok');
  } catch (error) {
    botLogger.error({ err: error }, 'Failed to create health file');
  }

  // Register commands
  const token = process.env.DISCORD_TOKEN;
  const clientId = client.user?.id;
  if (token && clientId) {
    const rest = new REST({ version: '10' }).setToken(token);
    try {
      botLogger.info({ commandCount: commands.length }, 'Started refreshing application (/) commands');
      await rest.put(
        Routes.applicationCommands(clientId),
        { body: commands },
      );
      botLogger.info('Application (/) commands reloaded');
    } catch (error) {
      botLogger.error({ err: error }, 'Failed to reload application commands');
    }
  }

  // Run initial poll after bot is ready
  await runPoll();

  // Start periodic database backups (every 60 minutes by default)
  const isBackupEnabled = process.env.BACKUP_ENABLED !== 'false';
  const backupIntervalMinutes = Number(process.env.BACKUP_INTERVAL_MINUTES ?? '60');
  const backupMaxKeep = Number(process.env.BACKUP_MAX_KEEP ?? '5');
  if (isBackupEnabled && !Number.isNaN(backupIntervalMinutes) && backupIntervalMinutes > 0) {
    // Run initial backup immediately, then periodically
    try {
      await createTimestampedBackup(backupMaxKeep);
      botLogger.info({ enabled: isBackupEnabled, interval_minutes: backupIntervalMinutes, max_keep: backupMaxKeep }, 'Database backup completed');
    } catch (error) {
      botLogger.error({ err: error }, 'Failed to create initial database backup');
    }
    botState.backupIntervalId = setInterval(async () => {
      try {
        await createTimestampedBackup(backupMaxKeep);
        botLogger.info('Periodic database backup completed');
      } catch (error) {
        botLogger.error({ err: error }, 'Failed to create periodic database backup');
      }
    }, backupIntervalMinutes * 60 * 1000);
  }
};

async function checkAdminPermission(interaction: ChatInputCommandInteraction): Promise<boolean> {
  const adminRoleIdValue = process.env.DISCORD_ADMIN_ROLE_ID;
  const adminRoleId = adminRoleIdValue?.trim();

  // Server administrators always pass. When no admin role is configured, the
  // Discord "Administrator" permission is the only gate (mirrored by each
  // command's setDefaultMemberPermissions), so commands are never world-open.
  let hasPermission = interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator) ?? false;

  if (!hasPermission && adminRoleId && interaction.member) {
    const member = interaction.member;

    // Fast path: check the roles already cached on the interaction member.
    if ('roles' in member && typeof member.roles === 'object' && 'cache' in member.roles && member.roles.cache instanceof Map) {
      hasPermission = member.roles.cache.has(adminRoleId);
    }

    // Authoritative fallback: the cached roles can be incomplete, so fetch the
    // member from the guild and re-check before denying.
    if (!hasPermission && interaction.guild) {
      try {
        const fetchedMember = await interaction.guild.members.fetch(interaction.user.id);
        hasPermission = fetchedMember.roles.cache.has(adminRoleId);
      } catch (error) {
        botLogger.error({ err: error }, 'Failed to fetch member');
      }
    }
  }

  if (!hasPermission) {
    await interaction.reply({ content: 'You do not have permission to use this command.', flags: MessageFlags.Ephemeral });
    return false;
  }
  return true;
}

/**
 * Builds an embed for a single page of the /list-streamers command.
 */
function buildListEmbed(
  users: TrackedUser[],
  startIndex: number,
  maxRows: number,
  color: number,
  currentPage: number,
  totalPages: number,
): EmbedBuilder {
  const pageUsers = users.slice(startIndex, startIndex + maxRows);
  const embed = new EmbedBuilder().setColor(color).setTitle('Tracked Streamers');

  let description = '**Discord Username** | **Twitch Username** | **Date Added** | **Added By**\n';

  for (const user of pageUsers) {
    const addedDate = user.added_at ? new Date(user.added_at).toLocaleString() : 'Unknown';
    const discordUser = `<@${user.discord_id}>`;
    const addedBy = `<@${user.added_by}>`;
    description += `${discordUser} | \`${user.twitch_username}\` | ${addedDate} | ${addedBy}\n`;
  }

  embed.setDescription(description);

  if (totalPages > 1) {
    embed.setFooter({ text: `Page ${currentPage + 1} of ${totalPages}` });
  }

  return embed;
}

/**
 * Sends or edits the /list-streamers message for the given page.
 */
async function showPage(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  currentPage: number,
  maxRows: number,
  color: number,
  totalPages: number,
): Promise<void> {
  const state = listStreamersState.get(interaction.user.id);
  if (!state) return;

  const startIndex = currentPage * maxRows;
  const embed = buildListEmbed(state.users, startIndex, maxRows, color, currentPage, totalPages);

  const previousButton = new ButtonBuilder()
    .setCustomId('list_prev')
    .setLabel('Previous')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(currentPage === 0);

  const nextButton = new ButtonBuilder()
    .setCustomId('list_next')
    .setLabel('Next')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(currentPage === totalPages - 1);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(previousButton, nextButton);

  const editOptions = { embeds: [embed], components: [row] };
  await (interaction.replied || interaction.deferred
    ? interaction.editReply(editOptions)
    : interaction.reply({ ...editOptions, flags: MessageFlags.Ephemeral }));
}

const handleInteractionCreate = async (interaction: Interaction): Promise<void> => {
  // Handle button clicks for /list-streamers pagination
  if (interaction.isButton()) {
    if (interaction.customId === 'list_prev' || interaction.customId === 'list_next') {
      const state = listStreamersState.get(interaction.user.id);
      if (!state) return;

      // Only the original user can interact with the buttons
      if (interaction.user.id !== state.userId) {
        await interaction.reply({ content: 'These buttons are not for you!', flags: MessageFlags.Ephemeral });
        return;
      }

      const MAX_ROWS_PER_EMBED = 6;
      const EMBED_COLOR = 0x91_46_FF;
      const totalPages = Math.ceil(state.users.length / MAX_ROWS_PER_EMBED);

      let newPage = state.currentPage;
      if (interaction.customId === 'list_prev') {
        newPage = Math.max(0, newPage - 1);
      } else if (interaction.customId === 'list_next') {
        newPage = Math.min(totalPages - 1, newPage + 1);
      }

      state.currentPage = newPage;
      await showPage(interaction, newPage, MAX_ROWS_PER_EMBED, EMBED_COLOR, totalPages);
      
      // Schedule cleanup of pagination state after 60 seconds of inactivity
      setTimeout(() => {
        listStreamersState.delete(interaction.user.id);
      }, 60_000);
      
      return;
    }

    return;
  }

  if (!interaction.isChatInputCommand()) return;

  switch (interaction.commandName) {
  case 'add-streamer': {
    if (!(await checkAdminPermission(interaction))) return;

    const targetUser = interaction.options.getUser('user');
    const username = interaction.options.getString('username')?.toLowerCase();
    
    if (!targetUser || !username) return;

    // Security: Input Validation
    // Twitch usernames must be 4-25 characters long and contain only alphanumeric characters and underscores.
    const twitchUsernameRegex = /^[a-zA-Z0-9_]{4,25}$/;
    if (!twitchUsernameRegex.test(username)) {
      await interaction.reply({ 
        content: 'Invalid Twitch username format. It must be 4-25 characters long and contain only letters, numbers, and underscores.', 
        flags: MessageFlags.Ephemeral 
      });
      return;
    }

    try {
      const users = await getUsers([username]);
      if (users.length === 0) {
        await interaction.reply({ content: `Could not find a Twitch user with the username **${username}**.`, flags: MessageFlags.Ephemeral });
        return;
      }
      
      const twitchUser = users[0];

      upsertTrackedUserStatement.run(targetUser.id, twitchUser.login, twitchUser.id, Date.now(), interaction.user.id);

      await interaction.reply({ content: `Successfully linked Twitch account **${twitchUser.login}** to ${targetUser}!`, flags: MessageFlags.Ephemeral });
    } catch (error) {
      botLogger.error({ err: error, username }, 'Error linking Twitch account');
      await interaction.reply({ content: 'An error occurred while verifying the Twitch account.', flags: MessageFlags.Ephemeral });
    }
  
  break;
  }
  case 'remove-streamer': {
    if (!(await checkAdminPermission(interaction))) return;

    const targetUser = interaction.options.getUser('user');
    const username = interaction.options.getString('username')?.toLowerCase();

    if (!targetUser && !username) {
      await interaction.reply({ content: 'You must provide either a Discord user or a Twitch username to remove.', flags: MessageFlags.Ephemeral });
      return;
    }

    try {
      let result;
      if (targetUser) {
        result = deleteTrackedUserByDiscordIdStatement.run(targetUser.id);
      } else if (username) {
        result = deleteTrackedUserByTwitchUsernameStatement.run(username);
      }

      await (result && result.changes > 0 ? interaction.reply({ content: `Successfully removed the streamer.`, flags: MessageFlags.Ephemeral }) : interaction.reply({ content: `Could not find a tracked streamer matching that criteria.`, flags: MessageFlags.Ephemeral }));
    } catch (error) {
      botLogger.error({ err: error }, 'Error removing streamer');
      await interaction.reply({ content: 'An error occurred while removing the streamer.', flags: MessageFlags.Ephemeral });
    }
  
  break;
  }
  case 'list-streamers': {
    if (!(await checkAdminPermission(interaction))) return;

    const MAX_ROWS_PER_EMBED = 6;
    const EMBED_COLOR = 0x91_46_FF; // Twitch purple

    try {
      const users = selectAllTrackedUsersStatement.all() as TrackedUser[];

      if (users.length === 0) {
        await interaction.reply({ content: 'There are currently no tracked streamers.', flags: MessageFlags.Ephemeral });
        return;
      }

      // Store state for pagination
      const totalPages = Math.ceil(users.length / MAX_ROWS_PER_EMBED);
      listStreamersState.set(interaction.user.id, { users, currentPage: 0, userId: interaction.user.id });

      await showPage(interaction, 0, MAX_ROWS_PER_EMBED, EMBED_COLOR, totalPages);
    } catch (error) {
      botLogger.error({ err: error }, 'Error listing streamers');
      await interaction.reply({ content: 'An error occurred while listing streamers.', flags: MessageFlags.Ephemeral });
    }

    break;
  }
  case 'test-embed': {
    if (!(await checkAdminPermission(interaction))) return;

    const username = (interaction.options.getString('username') ?? '').toLowerCase();

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const users = await getUsers([username]);
      if (users.length === 0) {
        await interaction.editReply({ content: `Could not find a Twitch user with the username **${username}**.` });
        return;
      }
      
      const twitchUser = users[0];
      const streams = await getStreamsByIds([twitchUser.id]);
      
      const stream = streams.length > 0 ? streams[0] : {
        user_id: twitchUser.id,
        user_login: twitchUser.login,
        user_name: twitchUser.display_name,
        title: 'Test Stream Title',
        game_name: 'Just Chatting',
        viewer_count: 1337,
        thumbnail_url: 'https://static-cdn.jtvnw.net/previews-ttv/live_user_' + twitchUser.login + '-{width}x{height}.jpg',
        started_at: new Date().toISOString()
      };

      const announcementMessage = process.env.DISCORD_ANNOUNCEMENT_MESSAGE || 'Hey @everyone, {user} is now live on Twitch! {url}';
      const announcementText = announcementMessage
        .replace('{user}', () => stream.user_name)
        .replace('{mention}', () => `<@${interaction.user.id}>`)
        .replace('{url}', () => `https://twitch.tv/${stream.user_login}`);

      const embed = buildStreamEmbed(
        { ...stream },
        twitchUser,
      );

      const channelId = process.env.DISCORD_CHANNEL_ID;
      if (!channelId) {
        await interaction.editReply({ content: 'DISCORD_CHANNEL_ID is not configured.' });
        return;
      }

      const channel = interaction.guild?.channels.cache.get(channelId) as TextChannel;
      if (!channel) {
        await interaction.editReply({ content: `Could not find channel with ID ${channelId}.` });
        return;
      }

      await channel.send({ content: announcementText, embeds: [embed] });
      await interaction.editReply({ content: `Test embed sent to <#${channelId}>!` });
    } catch (error) {
      botLogger.error({ err: error }, 'Error sending test embed');
      await interaction.editReply({ content: 'An error occurred while sending the test embed.' });
    }
  
  break;
  }
  // No default
  }
};

export async function startBot() {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    logger.error('DISCORD_TOKEN environment variable is required');
    return;
  }

  // Register event handlers before logging in
  client.once(Events.ClientReady, handleClientReady);
  client.on(Events.InteractionCreate, handleInteractionCreate);

  // Start the polling loop - every 5 minutes
  botState.pollIntervalId = setInterval(runPoll, 5 * 60 * 1000);

  try {
    await client.login(token);
  } catch (error) {
    logger.error({ err: error }, 'Failed to login to Discord');
    throw error;
  }
}

export async function stopBot() {
  // Clear polling interval to prevent further execution
  if (botState.pollIntervalId !== undefined) {
    clearInterval(botState.pollIntervalId);
    botState.pollIntervalId = undefined;
  }

  // Clear backup interval to prevent further execution
  if (botState.backupIntervalId !== undefined) {
    clearInterval(botState.backupIntervalId);
    botState.backupIntervalId = undefined;
  }

  // Create a final backup before shutdown
  const isBackupEnabled = process.env.BACKUP_ENABLED !== 'false';
  const backupMaxKeep = Number(process.env.BACKUP_MAX_KEEP ?? '5');
  if (isBackupEnabled && !Number.isNaN(backupMaxKeep)) {
    try {
      await createTimestampedBackup(backupMaxKeep);
      botLogger.info('Final shutdown database backup completed');
    } catch (error) {
      botLogger.error({ err: error }, 'Failed to create final shutdown database backup');
    }
  }

  client.destroy();
  botState.isReady = false;
  try {
    if (fs.existsSync(HEALTH_FILE)) {
      fs.unlinkSync(HEALTH_FILE);
    }
  } catch (error) {
    logger.error({ err: error }, 'Failed to remove health file');
  }
}

/**
 * Runs the polling loop with race condition protection.
 * Uses isPolling flag to prevent concurrent executions from setInterval.
 */
async function runPoll() {
  if (botState.isPolling) return;
  // Chain onto the previous lock so poll cycles never overlap
  const previous = botState.pollLock;
  botState.pollLock = (async () => {
    await previous;
    try {
      await executePoll();
    } catch (error) {
      logger.error({ err: error }, 'Error in polling loop');
    }
  })();
  return botState.pollLock;
}

/**
 * Executes the actual polling logic.
 */
async function executePoll() {
  if (!botState.isReady || botState.isPolling) return;

  botLogger.debug('Poll cycle started');
  botState.isPolling = true;
  try {
    const roleId = process.env.DISCORD_ROLE_ID;
    const guildId = process.env.DISCORD_GUILD_ID;
    const channelId = process.env.DISCORD_CHANNEL_ID;

    if (!guildId || !channelId) {
      logger.warn('Missing required Discord configuration (GUILD_ID or CHANNEL_ID) in environment variables');
      return;
    }

    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
      logger.warn({ guild_id: guildId }, 'Guild not found');
      return;
    }

    // 1. Fetch tracked users from database
    const trackedUsers = selectAllTrackedUsersStatement.all() as TrackedUser[];
    botLogger.debug({ tracked_count: trackedUsers.length }, 'Fetched tracked users');
    if (trackedUsers.length === 0) return;

    // 2. Filter tracked users by those who currently have the role (if roleId is provided)
    const validTrackedUsers: TrackedUser[] = [];
    const orphanedUsers: string[] = [];

    if (roleId) {
      try {
        const discordIds = trackedUsers.map(u => u.discord_id);
        const members = await guild.members.fetch({ user: discordIds });
        for (const user of trackedUsers) {
          const member = members.get(user.discord_id);
          if (member && member.roles.cache.has(roleId)) {
            validTrackedUsers.push(user);
          } else if (!member) {
            orphanedUsers.push(user.discord_id);
          }
        }
      } catch (error) {
        logger.error({ err: error }, 'Error fetching members to check roles');
        return; // Skip this cycle if we can't verify roles
      }
    } else {
      validTrackedUsers.push(...trackedUsers);
    }

    // Clean up orphaned users
    if (orphanedUsers.length > 0) {
      logger.info({ count: orphanedUsers.length }, 'Cleaning up orphaned tracked users');
      for (const discordId of orphanedUsers) {
        deleteTrackedUserByDiscordIdStatement.run(discordId);
      }
    }

    if (validTrackedUsers.length === 0) return;

    const twitchIds = validTrackedUsers.map(u => u.twitch_id).filter(Boolean);
    if (twitchIds.length === 0) return;

    // Twitch API allows max 100 per request
    const chunks = [];
    for (let index = 0; index < twitchIds.length; index += 100) {
      chunks.push(twitchIds.slice(index, index + 100));
    }

    const liveStreams: TwitchStream[] = [];
    const failedTwitchIds = new Set<string>();
    for (const chunk of chunks) {
      try {
        const streams = await getStreamsByIds(chunk);
        liveStreams.push(...streams);
      } catch (error) {
        // Any failure means we could not verify this chunk's streams this cycle.
        // Mark them as failed so the offline handler does NOT treat them as
        // offline and delete still-live announcements (e.g. on a transient 401).
        for (const id of chunk) failedTwitchIds.add(id);

        if (error instanceof TwitchApiError) {
          logger.error({ error: error.message, status_code: error.statusCode }, 'Twitch API error');
          if (error.statusCode === 401) {
            // Token expired/invalid: clear it so the next chunk/cycle re-auths.
            clearTwitchToken();
            continue;
          }
        }
        logger.error({ err: error }, 'Failed to get streams');
      }
    }

    botLogger.debug({ live_count: liveStreams.length, failed_count: failedTwitchIds.size, twitch_ids_count: twitchIds.length }, 'Fetched live streams');

    const liveUserIds = new Set(liveStreams.map(s => s.user_id));
    const activeStreams = selectAllActiveStreamsStatement.all() as ActiveStream[];

    // Handle offline streams (delete message)
    for (const active of activeStreams) {
      if (!liveUserIds.has(active.twitch_id) && !failedTwitchIds.has(active.twitch_id)) {
        try {
          const channel = guild.channels.cache.get(active.channel_id) as TextChannel;
          if (channel) {
            const message = await channel.messages.fetch(active.message_id);
            if (message) await message.delete();
            logger.info({ twitch_id: active.twitch_id, message_id: active.message_id }, 'Stream went offline, deleted announcement');
          }
        } catch (error) {
          if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: number }).code === 10_008) { // Discord error code for unknown message
            logger.debug({ message_id: active.message_id }, 'Message already deleted, removing from DB');
          } else {
            logger.error({ err: error, twitch_id: active.twitch_id }, 'Failed to delete message');
          }
          deleteActiveStreamByTwitchIdStatement.run(active.twitch_id);
        }
      }
    }

    // Handle online streams (post or update message)
    const channel = guild.channels.cache.get(channelId) as TextChannel;
    if (!channel) return;

    // Fetch user profiles for avatars (using cache)
    const userProfileMap = new Map<string, TwitchUser>();
    for (const stream of liveStreams) {
      const profile = await getUserProfile(stream.user_id);
      if (profile) {
        userProfileMap.set(stream.user_id, profile);
      }
    }

    const announcementMessage = process.env.DISCORD_ANNOUNCEMENT_MESSAGE || 'Hey @everyone, {user} is now live on Twitch! {url}';

    for (const stream of liveStreams) {
      const twitchId = stream.user_id;
      const active = activeStreams.find(a => a.twitch_id === twitchId);
      const profile = userProfileMap.get(twitchId);
      const trackedUser = validTrackedUsers.find(u => u.twitch_id === twitchId);

      // Update cached username if it changed
      if (trackedUser && trackedUser.twitch_username !== stream.user_login) {
        updateTrackedUserTwitchUsernameStatement.run(stream.user_login, twitchId);
        trackedUser.twitch_username = stream.user_login; // Update local object too
      }

      const username = stream.user_login;

      const embed = buildStreamEmbed(stream, profile);

      const announcementText = announcementMessage
        .replace('{user}', () => stream.user_name)
        .replace('{mention}', () => `<@${trackedUser?.discord_id}>`)
        .replace('{url}', () => `https://twitch.tv/${username}`);

      if (active) {
        // Update existing message
        try {
          const message = await channel.messages.fetch(active.message_id);
          if (message) {
            await message.edit({ embeds: [embed] });
            botLogger.info({ twitch_id: twitchId, twitch_username: username, message_id: active.message_id }, 'Stream announcement updated');
          }
        } catch (error) {
          botLogger.error({ err: error, twitch_username: username }, 'Failed to update message');
          // If message deleted, remove from active_streams so it posts again next time
          deleteActiveStreamByTwitchIdStatement.run(twitchId);
        }
      } else {
        // Post new message
        try {
          const message = await channel.send({ content: announcementText, embeds: [embed] });
          insertActiveStreamStatement.run(twitchId, trackedUser?.discord_id, message.id, channel.id, Date.now());
          botLogger.info({ twitch_id: twitchId, twitch_username: username, user_name: stream.user_name, game_name: stream.game_name, viewer_count: stream.viewer_count, message_id: message.id, channel_id: channel.id }, 'Stream is live, announcement posted');
        } catch (error) {
          botLogger.error({ err: error, twitch_username: username }, 'Failed to send message');
        }
      }
    }
  } catch (error) {
    logger.error({ err: error }, 'Error in polling loop');
  } finally {
    botState.isPolling = false;
  }
}
