import type { TwitchStream, TwitchUser } from './twitch.js';
import type { ButtonInteraction, ChatInputCommandInteraction, GuildMember, TextChannel } from 'discord.js';

import fs from 'node:fs';

import db from './db.js';
import { logger } from './logger.js';
import { clearTwitchToken, getStreamsByIds, getUsers, getUsersByIds, TwitchApiError } from './twitch.js';

import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, EmbedBuilder, Events,
  GatewayIntentBits, MessageFlags, PermissionsBitField, REST, Routes,
  SlashCommandBuilder
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

// Polling with Promise-based locking to prevent race conditions
let isPolling = false;
let pollLock = Promise.resolve();

// User profile cache
interface UserProfileCacheEntry {
  profile: TwitchUser;
  timestamp: number;
}
const userProfileCache = new Map<string, UserProfileCacheEntry>();

// State for paginated /list-streamers button interactions
interface ListStreamersState {
  users: TrackedUser[];
  currentPage: number;
}
const listStreamersState = new Map<string, ListStreamersState>();

/**
 * Gets a user profile from cache or fetches it from Twitch API.
 */
async function getUserProfile(userId: string): Promise<TwitchUser | undefined> {
  const cached = userProfileCache.get(userId);
  if (cached && Date.now() - cached.timestamp < USER_PROFILE_CACHE_TTL) {
    return cached.profile;
  }
  
  try {
    const users = await getUsersByIds([userId]);
    if (users.length > 0) {
      userProfileCache.set(userId, {
        profile: users[0],
        timestamp: Date.now()
      });
      return users[0];
    }
  } catch (error) {
    logger.error({ err: error, user_id: userId }, 'Failed to get user profile');
  }
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
    language?: string;
    tags?: string[];
    is_mature?: boolean;
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
      `🟢 **LIVE** now playing **${stream.game_name || 'Just Chatting'}**\n\n${stream.title || ''}`,
    );

  // Thumbnail (small avatar in top-right)
  if (profile?.profile_image_url) {
    embed.setThumbnail(profile.profile_image_url);
  }

  // Game field with broadcaster type badge
  const broadcasterBadge =
    profile?.broadcaster_type === 'partner'
      ? '\u{1F534} Partner'
      : (profile?.broadcaster_type === 'affiliate'
        ? '\u{1F4E5} Affiliate'
        : '');
  const gameValue = broadcasterBadge
    ? `${stream.game_name || 'Just Chatting'}\n${broadcasterBadge}`
    : stream.game_name || 'Just Chatting';

  embed.addFields(
    { name: '\u{1F3AE} Game', value: gameValue, inline: true },
    { name: '\u{1F441} Viewers', value: stream.viewer_count.toLocaleString(), inline: true },
    { name: '\u23F1 Duration', value: formatStreamDuration(stream.started_at), inline: true },
  );

  // Language field (if available)
  if (stream.language) {
    embed.addFields({ name: '\u{1F310} Language', value: stream.language.toUpperCase(), inline: true });
  }

  // Tags field (full width, top 3)
  if (stream.tags && stream.tags.length > 0) {
    embed.addFields({
      name: '\u{1F3F7}\uFE0F Tags',
      value: stream.tags.slice(0, 3).join(', '),
      inline: false,
    });
  }

  // Full-size image (compact preview, clickable to expand)
  embed.setImage(thumbnailUrl);

  // Timestamp
  embed.setTimestamp(new Date(stream.started_at));
  return embed;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
  ]
});

let isReady = false;

export function isBotReady() {
  return isReady;
}

const commands = [
  new SlashCommandBuilder()
    .setName('add-streamer')
    .setDescription('Link a Twitch username to a Discord user')
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
    .setDescription('List all tracked streamers'),
  new SlashCommandBuilder()
    .setName('test-embed')
    .setDescription('Send a test live notification')
    .addStringOption(option =>
      option.setName('username')
        .setDescription('The Twitch username to test with')
        .setRequired(true)),
].map(command => command.toJSON());

const botLogger = logger.child({ name: 'bot' });

client.once(Events.ClientReady, async () => {
  botLogger.info({ username: client.user?.tag }, 'Bot logged in');
  isReady = true;
  
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
});

async function checkAdminPermission(interaction: ChatInputCommandInteraction): Promise<boolean> {
  const adminRoleId = process.env.DISCORD_ADMIN_ROLE_ID?.trim();
  
  if (!adminRoleId) return true;
  
  let hasPermission = false;
  
  if (interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
    hasPermission = true;
  }
  
  if (!hasPermission && interaction.member) {
    const member = interaction.member;
    if (Array.isArray(member.roles)) {
      hasPermission = member.roles.includes(adminRoleId);
    } else {
      const guildMember = member as GuildMember;
      hasPermission = guildMember.roles.cache.has(adminRoleId);
      
      if (!hasPermission && interaction.guild) {
         try {
           const fetchedMember = await interaction.guild.members.fetch(interaction.user.id);
           hasPermission = fetchedMember.roles.cache.has(adminRoleId);
         } catch (error) {
           botLogger.error({ err: error }, 'Failed to fetch member');
         }
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

  const prevButton = new ButtonBuilder()
    .setCustomId('list_prev')
    .setLabel('Previous')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(currentPage === 0);

  const nextButton = new ButtonBuilder()
    .setCustomId('list_next')
    .setLabel('Next')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(currentPage === totalPages - 1);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(prevButton, nextButton);

  const editOpts = { embeds: [embed], components: [row] };
  await (interaction.replied || interaction.deferred
    ? interaction.editReply(editOpts)
    : interaction.reply({ ...editOpts, flags: MessageFlags.Ephemeral }));
}

client.on('interactionCreate', async interaction => {
  // Handle button clicks for /list-streamers pagination
  if (interaction.isButton()) {
    if (interaction.customId === 'list_prev' || interaction.customId === 'list_next') {
      const state = listStreamersState.get(interaction.user.id);
      if (!state) return;

      // Only the original user can interact with the buttons
      if (interaction.user.id !== interaction.user.id) {
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

      db.prepare(`
        INSERT INTO tracked_users (discord_id, twitch_username, twitch_id, added_at, added_by) 
        VALUES (?, ?, ?, ?, ?) 
        ON CONFLICT(discord_id) DO UPDATE SET 
          twitch_username = excluded.twitch_username, 
          twitch_id = excluded.twitch_id,
          added_at = excluded.added_at,
          added_by = excluded.added_by
      `).run(targetUser.id, twitchUser.login, twitchUser.id, Date.now(), interaction.user.id);

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
        result = db.prepare('DELETE FROM tracked_users WHERE discord_id = ?').run(targetUser.id);
      } else if (username) {
        result = db.prepare('DELETE FROM tracked_users WHERE twitch_username = ?').run(username);
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
      const users = db.prepare('SELECT * FROM tracked_users ORDER BY added_at ASC').all() as TrackedUser[];

      if (users.length === 0) {
        await interaction.reply({ content: 'There are currently no tracked streamers.', flags: MessageFlags.Ephemeral });
        return;
      }

      // Store state for pagination
      const totalPages = Math.ceil(users.length / MAX_ROWS_PER_EMBED);
      listStreamersState.set(interaction.user.id, { users, currentPage: 0 });

      await showPage(interaction, 0, MAX_ROWS_PER_EMBED, EMBED_COLOR, totalPages);
    } catch (error) {
      botLogger.error({ err: error }, 'Error listing streamers');
      await interaction.reply({ content: 'An error occurred while listing streamers.', flags: MessageFlags.Ephemeral });
    }

    break;
  }
  case 'test-embed': {
    if (!(await checkAdminPermission(interaction))) return;

    const username = interaction.options.getString('username')?.toLowerCase();
    if (!username) return;

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

      const announcementMsg = process.env.DISCORD_ANNOUNCEMENT_MESSAGE || 'Hey @everyone, {user} is now live on Twitch! {url}';
      const announcementText = announcementMsg
        .replace('{user}', stream.user_name)
        .replace('{mention}', `<@${interaction.user.id}>`)
        .replace('{url}', `https://twitch.tv/${stream.user_login}`);

      const embed = buildStreamEmbed(
        { ...stream, language: 'en', tags: ['English', 'Entertainment'] },
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
});

export async function startBot() {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    logger.error('DISCORD_TOKEN environment variable is required');
    return;
  }
  try {
    await client.login(token);
    logger.info({ username: client.user?.tag }, 'Bot logged in');
  } catch (error) {
    logger.error({ err: error }, 'Failed to login to Discord');
    throw error;
  }
}

export async function stopBot() {
  client.destroy();
  isReady = false;
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
 */
async function runPoll() {
  await pollLock;
  pollLock = pollLock.then(async () => {
    try {
      await executePoll();
    } catch (error) {
      logger.error({ err: error }, 'Error in polling loop');
    }
  });
  return pollLock;
}

/**
 * Executes the actual polling logic.
 */
async function executePoll() {
  if (!isReady || isPolling) return;
  
  botLogger.debug('Poll cycle started');
  isPolling = true;
  try {
    const roleId = process.env.DISCORD_ROLE_ID;
    const guildId = process.env.DISCORD_GUILD_ID;
    const channelId = process.env.DISCORD_CHANNEL_ID;
    const announcementMsg = process.env.DISCORD_ANNOUNCEMENT_MESSAGE || 'Hey @everyone, {user} is now live on Twitch! {url}';

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
    const trackedUsers = db.prepare("SELECT * FROM tracked_users").all() as TrackedUser[];
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
        db.prepare('DELETE FROM tracked_users WHERE discord_id = ?').run(discordId);
      }
    }

    if (validTrackedUsers.length === 0) return;

    const twitchIds = validTrackedUsers.map(u => u.twitch_id).filter(Boolean);
    if (twitchIds.length === 0) return;

    // Twitch API allows max 100 per request
    const chunks = [];
    for (let i = 0; i < twitchIds.length; i += 100) {
      chunks.push(twitchIds.slice(i, i + 100));
    }

    const liveStreams: TwitchStream[] = [];
    const failedTwitchIds = new Set<string>();
    for (const chunk of chunks) {
      try {
        const streams = await getStreamsByIds(chunk);
        liveStreams.push(...streams);
      } catch (error) {
        if (error instanceof TwitchApiError) {
          logger.error({ error: error.message, status_code: error.statusCode }, 'Twitch API error');
          if (error.statusCode === 401) {
            // Token expired, clear it and retry
            clearTwitchToken();
            continue;
          }
        }
        logger.error({ err: error }, 'Failed to get streams');
        for (const id of chunk) failedTwitchIds.add(id);
      }
    }

    botLogger.debug({ live_count: liveStreams.length, failed_count: failedTwitchIds.size, twitch_ids_count: twitchIds.length }, 'Fetched live streams');

    const liveUserIds = new Set(liveStreams.map(s => s.user_id));
    const activeStreams = db.prepare("SELECT * FROM active_streams").all() as ActiveStream[];

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
          db.prepare("DELETE FROM active_streams WHERE twitch_id = ?").run(active.twitch_id);
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

    for (const stream of liveStreams) {
      const twitchId = stream.user_id;
      const active = activeStreams.find(a => a.twitch_id === twitchId);
      const profile = userProfileMap.get(twitchId);
      const trackedUser = validTrackedUsers.find(u => u.twitch_id === twitchId);
      
      // Update cached username if it changed
      if (trackedUser && trackedUser.twitch_username !== stream.user_login) {
        db.prepare('UPDATE tracked_users SET twitch_username = ? WHERE twitch_id = ?').run(stream.user_login, twitchId);
        trackedUser.twitch_username = stream.user_login; // Update local object too
      }

      const username = stream.user_login;
      
      const embed = buildStreamEmbed(stream, profile);

      const announcementText = announcementMsg
        .replace('{user}', stream.user_name)
        .replace('{mention}', `<@${trackedUser?.discord_id}>`)
        .replace('{url}', `https://twitch.tv/${username}`);

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
          db.prepare("DELETE FROM active_streams WHERE twitch_id = ?").run(twitchId);
        }
      } else {
        // Post new message
        try {
          const message = await channel.send({ content: announcementText, embeds: [embed] });
          db.prepare(`
            INSERT INTO active_streams (twitch_id, discord_id, message_id, channel_id, start_time)
            VALUES (?, ?, ?, ?, ?)
          `).run(twitchId, trackedUser?.discord_id, message.id, channel.id, Date.now());
          botLogger.info({ twitch_id: twitchId, twitch_username: username, user_name: stream.user_name, game_name: stream.game_name, viewer_count: stream.viewer_count, message_id: message.id, channel_id: channel.id }, 'Stream is live, announcement posted');
        } catch (error) {
          botLogger.error({ err: error, twitch_username: username }, 'Failed to send message');
        }
      }
    }
  } catch (error) {
    logger.error({ err: error }, 'Error in polling loop');
  } finally {
    isPolling = false;
  }
}

// Polling loop - every 5 minutes
setInterval(runPoll, 5 * 60 * 1000);
