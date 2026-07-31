import type { TwitchStream, TwitchUser } from './twitch.js';
import type { ChatInputCommandInteraction, GuildMember, Interaction, TextChannel, User } from 'discord.js';

import fs from 'node:fs';

import database, { createTimestampedBackup } from './database.js';
import { parsePositiveIntEnvironment } from './environment.js';
import { logger } from './logger.js';
import { clearTwitchToken, getStreamsByIds, getUsers, getUsersByIds, TwitchApiError } from './twitch.js';

import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, ComponentType, EmbedBuilder, Events,
  GatewayIntentBits, InteractionContextType, MessageFlags, Options, PermissionsBitField,
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
// Poll Twitch every 5 minutes by default; overridable via POLL_INTERVAL_MINUTES
// (validated as a positive integer, so the effective floor is 1 minute).
const POLL_INTERVAL_MINUTES = parsePositiveIntEnvironment('POLL_INTERVAL_MINUTES', 5);
const POLL_INTERVAL_MS = POLL_INTERVAL_MINUTES * 60 * 1000;
// A completed poll cycle refreshes the health file. If none completes within
// this window the poll loop is wedged (an await that never resolves), which a
// restart can fix — so the watchdog exits. This is deliberately decoupled from
// Twitch/Discord API success: a Twitch outage is a handled path that still
// completes a cycle, so it never trips this. Derived from the poll interval and
// kept above 2 poll intervals (plus a minute of slack) so a single slow cycle
// is never mistaken for a hang.
const HEALTH_STALE_MS = 2 * POLL_INTERVAL_MS + 60 * 1000;
const HEALTH_WATCHDOG_INTERVAL_MS = 60 * 1000; // How often to check for a wedged loop
const USER_PROFILE_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
const USER_PROFILE_CACHE_MAX_SIZE = 1000;
const TWITCH_USERS_BATCH_SIZE = 100; // Twitch helix /users accepts up to 100 ids per request
const MEMBER_FETCH_TIMEOUT_MS = 30_000; // Fail fast on a degraded gateway instead of the ~120s default
const MEMBER_FETCH_BATCH_SIZE = 100; // Gateway REQUEST_GUILD_MEMBERS accepts at most 100 user_ids per call

// Discord API error codes that mean the target no longer exists, so an active
// announcement row can be safely dropped. Any other error is transient and the
// row must be retained so the next cycle retries.
const DISCORD_ERROR_UNKNOWN_CHANNEL = 10_003;
const DISCORD_ERROR_UNKNOWN_MESSAGE = 10_008;

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
  // Health watchdog timer reference for cleanup on shutdown
  healthWatchdogId: ReturnType<typeof setInterval> | undefined;
  // Timestamp (ms) of the last completed poll cycle; drives the health signal
  lastHealthyAt: number;
  // Whether the Discord client has reached the ready state
  isReady: boolean;
} = {
  isPolling: false,
  pollLock: Promise.resolve(),
  pollIntervalId: undefined,
  backupIntervalId: undefined,
  healthWatchdogId: undefined,
  lastHealthyAt: 0,
  isReady: false,
};

// User profile cache with LRU eviction
interface UserProfileCacheEntry {
  profile: TwitchUser;
  timestamp: number;
}
const userProfileCache = new Map<string, UserProfileCacheEntry>();

// Presentation constants for /list-streamers
const LIST_ROWS_PER_PAGE = 10;
const LIST_EMBED_COLOR = 0x91_46_FF; // Twitch purple
const LIST_COLLECTOR_TIMEOUT_MS = 120_000;

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
const selectTrackedUserByTwitchIdStatement = database.prepare('SELECT * FROM tracked_users WHERE twitch_id = ?');
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
 * Resolves multiple user profiles at once. Cache hits are served directly and
 * all cache misses are fetched in batched requests (up to 100 ids per Twitch
 * call) instead of one serial round-trip per user.
 */
async function getUserProfiles(userIds: string[]): Promise<Map<string, TwitchUser>> {
  const result = new Map<string, TwitchUser>();
  const now = Date.now();
  const misses: string[] = [];

  for (const userId of userIds) {
    const cached = userProfileCache.get(userId);
    if (cached && now - cached.timestamp < USER_PROFILE_CACHE_TTL) {
      result.set(userId, cached.profile);
    } else {
      if (cached) userProfileCache.delete(userId); // drop expired entry
      misses.push(userId);
    }
  }

  // Fetch misses in batches; Twitch accepts up to 100 ids per request.
  for (let index = 0; index < misses.length; index += TWITCH_USERS_BATCH_SIZE) {
    const batch = misses.slice(index, index + TWITCH_USERS_BATCH_SIZE);
    try {
      const users = await getUsersByIds(batch);
      for (const user of users) {
        while (userProfileCache.size >= USER_PROFILE_CACHE_MAX_SIZE) {
          evictLeastRecentlyUsed();
        }
        userProfileCache.set(user.id, { profile: user, timestamp: Date.now() });
        result.set(user.id, user);
      }
    } catch (error) {
      logger.error({ err: error, user_ids: batch }, 'Failed to get user profiles');
    }
  }

  return result;
}

/**
 * Extracts the numeric Discord API error code from a thrown error, if present.
 * discord.js attaches `code` to DiscordAPIError (e.g. 10008 Unknown Message).
 */
function getDiscordErrorCode(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'number') return code;
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

/**
 * Sweeper predicate for client.users.cache: evict everything except the bot's
 * own user. Safe because nothing here reads that cache — tracked members are
 * re-fetched from the gateway every poll cycle, and checkAdminPermission
 * already falls back to a fetch when the cached roles miss. Called by the
 * sweeper long after `client` is assigned, so the reference below is resolved.
 */
function isNotClientUser(user: User): boolean {
  return user.id !== client.user?.id;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
  ],
  sweepers: {
    ...Options.DefaultSweeperSettings,
    // client.users.cache has no eviction path of its own:
    // GUILD_MEMBER_REMOVE drops the member but leaves the User behind.
    users: { interval: 3600, filter: () => isNotClientUser },
  },
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

/**
 * Records a liveness heartbeat: (re)writes the health file so its mtime is
 * current and records the timestamp the watchdog reads. Called on ready and at
 * the end of every completed poll cycle — the signal is "the loop is running",
 * not "Twitch/Discord are reachable".
 */
function recordHealthy(): void {
  botState.lastHealthyAt = Date.now();
  try {
    fs.writeFileSync(HEALTH_FILE, 'ok');
  } catch (error) {
    botLogger.error({ err: error }, 'Failed to update health file');
  }
}

const handleClientReady = async (): Promise<void> => {
  botLogger.info({ username: client.user?.tag }, 'Bot logged in');
  botState.isReady = true;

  // Emit an initial heartbeat so the healthcheck passes before the first poll.
  recordHealthy();

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

  // Start the recurring poll only now that the client is ready. Registering it
  // before login would leave a live timer holding the event loop open on a
  // failed login — a zombie process that never announces and never restarts.
  botState.pollIntervalId = setInterval(runPoll, POLL_INTERVAL_MS);

  // Watchdog: if the poll loop stops completing cycles (a hung await), the
  // process is wedged-but-alive — a state a restart fixes. Exit so the restart
  // policy recovers us. A Twitch outage does NOT trip this: those cycles still
  // complete and refresh the heartbeat.
  botState.healthWatchdogId = setInterval(() => {
    const staleForMs = Date.now() - botState.lastHealthyAt;
    if (staleForMs > HEALTH_STALE_MS) {
      botLogger.fatal({ stale_ms: staleForMs }, 'Poll loop has not completed a cycle within the health window; exiting for restart.');
      process.exit(1);
    }
  }, HEALTH_WATCHDOG_INTERVAL_MS);

  // Start periodic database backups (every 60 minutes by default)
  const isBackupEnabled = process.env.BACKUP_ENABLED !== 'false';
  const backupIntervalMinutes = parsePositiveIntEnvironment('BACKUP_INTERVAL_MINUTES', 60);
  const backupMaxKeep = parsePositiveIntEnvironment('BACKUP_MAX_KEEP', 5);
  if (isBackupEnabled) {
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
function buildListEmbed(users: TrackedUser[], page: number, rowsPerPage: number, color: number): EmbedBuilder {
  const totalPages = Math.ceil(users.length / rowsPerPage);
  const startIndex = page * rowsPerPage;
  const pageUsers = users.slice(startIndex, startIndex + rowsPerPage);

  const lines = pageUsers.map((user, index) => {
    const position = startIndex + index + 1;
    const twitchLink = `[\`${user.twitch_username}\`](https://twitch.tv/${user.twitch_username})`;
    const addedClause = user.added_at ? ` added <t:${Math.floor(user.added_at / 1000)}:R>` : '';
    return `**${position}.** <@${user.discord_id}> — ${twitchLink}\n   ↳${addedClause} by <@${user.added_by}>`;
  });

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`Tracked Streamers · ${users.length} total`)
    .setDescription(lines.join('\n'));

  if (totalPages > 1) {
    embed.setFooter({ text: `Page ${page + 1} of ${totalPages}` });
  }

  return embed;
}

/**
 * Builds the Previous/Next pagination row, disabling buttons at the page boundaries.
 */
function buildListRow(page: number, totalPages: number, isDisabled = false): ActionRowBuilder<ButtonBuilder> {
  const previousButton = new ButtonBuilder()
    .setCustomId('list_prev')
    .setLabel('Previous')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(isDisabled || page === 0);

  const nextButton = new ButtonBuilder()
    .setCustomId('list_next')
    .setLabel('Next')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(isDisabled || page === totalPages - 1);

  return new ActionRowBuilder<ButtonBuilder>().addComponents(previousButton, nextButton);
}

// Reply to an interaction without ever throwing: discord.js rejects if the
// interaction was already answered or its 3s token expired, and an unhandled
// rejection here would crash the process. Pick the correct method for the
// interaction's current state and swallow (log) any failure.
const safeRespondToInteraction = async (
  interaction: ChatInputCommandInteraction,
  content: string,
): Promise<void> => {
  try {
    if (interaction.deferred) {
      await interaction.editReply({ content });
    } else if (interaction.replied) {
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
  } catch (error) {
    botLogger.error({ err: error }, 'Failed to respond to interaction');
  }
};

const handleInteractionCreate = async (interaction: Interaction): Promise<void> => {
  if (!interaction.isChatInputCommand()) return;

  try {
  switch (interaction.commandName) {
  case 'add-streamer': {
    if (!(await checkAdminPermission(interaction))) return;

    const targetUser = interaction.options.getUser('user');
    const username = interaction.options.getString('username')?.toLowerCase();
    
    if (!targetUser || !username) return;

    // Security: Input Validation
    // Twitch usernames must be 4-25 characters long and contain only alphanumeric characters and underscores.
    const twitchUsernameRegex = /^[a-zA-Z0-9_]{3,25}$/;
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

      // Prevent duplicate twitch_id links
      const existingLink = selectTrackedUserByTwitchIdStatement.get(twitchUser.id) as TrackedUser | undefined;
      if (existingLink && existingLink.discord_id !== targetUser.id) {
        await interaction.reply({
          content: `Twitch account **${twitchUser.login}** is already linked to <@${existingLink.discord_id}>. Remove that link first if you want to reassign it.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      upsertTrackedUserStatement.run(targetUser.id, twitchUser.login, twitchUser.id, Date.now(), interaction.user.id);

      await interaction.reply({ content: `Successfully linked Twitch account **${twitchUser.login}** to ${targetUser}!`, flags: MessageFlags.Ephemeral });
    } catch (error) {
      botLogger.error({ err: error, username }, 'Error linking Twitch account');
      await safeRespondToInteraction(interaction, 'An error occurred while verifying the Twitch account.');
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
      await safeRespondToInteraction(interaction, 'An error occurred while removing the streamer.');
    }
  
  break;
  }
  case 'list-streamers': {
    if (!(await checkAdminPermission(interaction))) return;

    try {
      const users = selectAllTrackedUsersStatement.all() as TrackedUser[];

      if (users.length === 0) {
        await interaction.reply({ content: 'There are currently no tracked streamers.', flags: MessageFlags.Ephemeral });
        return;
      }

      const totalPages = Math.ceil(users.length / LIST_ROWS_PER_PAGE);
      const embed = buildListEmbed(users, 0, LIST_ROWS_PER_PAGE, LIST_EMBED_COLOR);

      // A single page needs no controls — avoids holding any pagination state at all.
      if (totalPages === 1) {
        await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        break;
      }

      await interaction.reply({
        embeds: [embed],
        components: [buildListRow(0, totalPages)],
        flags: MessageFlags.Ephemeral,
      });

      // Pagination state lives only for the lifetime of this collector — no global map,
      // so nothing is retained once the message stops being interacted with.
      let currentPage = 0;
      const message = await interaction.fetchReply();
      const collector = message.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: LIST_COLLECTOR_TIMEOUT_MS,
      });

      collector.on('collect', async (buttonInteraction) => {
        // The collector runs outside handleInteractionCreate's try/catch, so a
        // rejected update() here would be an unhandled rejection — contain it.
        try {
          if (buttonInteraction.user.id !== interaction.user.id) {
            await buttonInteraction.reply({ content: 'These buttons are not for you!', flags: MessageFlags.Ephemeral });
            return;
          }

          currentPage = buttonInteraction.customId === 'list_prev'
            ? Math.max(0, currentPage - 1)
            : Math.min(totalPages - 1, currentPage + 1);

          await buttonInteraction.update({
            embeds: [buildListEmbed(users, currentPage, LIST_ROWS_PER_PAGE, LIST_EMBED_COLOR)],
            components: [buildListRow(currentPage, totalPages)],
          });
          collector.resetTimer();
        } catch (error) {
          botLogger.error({ err: error }, 'Error handling pagination button');
        }
      });

      collector.on('end', async () => {
        // Grey out the buttons once paging expires so they don't look clickable.
        try {
          await interaction.editReply({ components: [buildListRow(currentPage, totalPages, true)] });
        } catch {
          // The ephemeral message may have been dismissed; nothing to clean up.
        }
      });
    } catch (error) {
      botLogger.error({ err: error }, 'Error listing streamers');
      await safeRespondToInteraction(interaction, 'An error occurred while listing streamers.');
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
      await safeRespondToInteraction(interaction, 'An error occurred while sending the test embed.');
    }
  
  break;
  }
  // No default
  }
  } catch (error) {
    // Last line of defence: any handler throwing (including a failed reply in a
    // case's own catch block) is contained here so it can never surface as an
    // unhandled rejection and crash the process.
    botLogger.error({ err: error, command: interaction.commandName }, 'Unhandled error handling interaction');
    await safeRespondToInteraction(interaction, 'An unexpected error occurred while processing the command.');
  }
};

export async function startBot() {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    logger.error('DISCORD_TOKEN environment variable is required');
    process.exit(1);
  }

  // Register event handlers before logging in
  client.once(Events.ClientReady, handleClientReady);
  client.on(Events.InteractionCreate, handleInteractionCreate);
  // Without a listener, an emitted 'error' on the client (an EventEmitter) is
  // rethrown and crashes the process. Log it and let discord.js keep reconnecting.
  client.on(Events.Error, (error) => {
    botLogger.error({ err: error }, 'Discord client error');
  });
  // Stop bot if session invalidated. Usually auth issues or token revocation.
  client.on(Events.Invalidated, () => {
    botLogger.fatal('Discord session invalidated; the client will not reconnect. Exiting.');
    process.exit(1);
  });

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

  // Clear health watchdog so it can't exit(1) mid-shutdown
  if (botState.healthWatchdogId !== undefined) {
    clearInterval(botState.healthWatchdogId);
    botState.healthWatchdogId = undefined;
  }

  // Clear backup interval to prevent further execution
  if (botState.backupIntervalId !== undefined) {
    clearInterval(botState.backupIntervalId);
    botState.backupIntervalId = undefined;
  }

  // Wait for any in-flight poll cycle to finish before touching the database.
  // The final backup (and the caller's closeDatabase()) must not run while a
  // poll is still reading/writing rows, or prepared statements hit a closed DB
  // and the backup can snapshot a half-written state.
  try {
    await botState.pollLock;
  } catch {
    // A failed poll already logs its own error; we only care that it settled.
  }

  // Create a final backup before shutdown
  const isBackupEnabled = process.env.BACKUP_ENABLED !== 'false';
  const backupMaxKeep = parsePositiveIntEnvironment('BACKUP_MAX_KEEP', 5);
  if (isBackupEnabled) {
    try {
      await createTimestampedBackup(backupMaxKeep);
      botLogger.info('Final shutdown database backup completed');
    } catch (error) {
      botLogger.error({ err: error }, 'Failed to create final shutdown database backup');
    }
  }

  // client.destroy() returns a Promise in discord.js v14; await it so the
  // gateway connection is fully torn down before the process exits.
  await client.destroy();
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
    } finally {
      // A cycle that ran to completion — even one that logged a handled Twitch
      // error — proves the loop is alive. Refresh the heartbeat regardless.
      recordHealthy();
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
        // The gateway REQUEST_GUILD_MEMBERS op rejects >100 user_ids: discord.js
        // passes the array straight through, so a single fetch of the whole set
        // times out past 100 tracked users. Fetch in batches and merge.
        const members = new Map<string, GuildMember>();
        for (let index = 0; index < discordIds.length; index += MEMBER_FETCH_BATCH_SIZE) {
          const batch = discordIds.slice(index, index + MEMBER_FETCH_BATCH_SIZE);
          const fetched = await guild.members.fetch({ user: batch, time: MEMBER_FETCH_TIMEOUT_MS });
          for (const [id, member] of fetched) members.set(id, member);
        }
        for (const user of trackedUsers) {
          const member = members.get(user.discord_id);
          if (member && member.roles.cache.has(roleId)) {
            validTrackedUsers.push(user);
          } else if (!member) {
            orphanedUsers.push(user.discord_id);
          }
        }
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'GuildMembersTimeout') {
          logger.warn('Timed out fetching members to check roles; skipping this poll cycle');
        } else {
          logger.error({ err: error }, 'Error fetching members to check roles');
        }
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
      // Skip streams that are still live, and those whose live status we could
      // not verify this cycle (failed Twitch fetch) — deleting those would
      // remove a still-valid announcement.
      if (liveUserIds.has(active.twitch_id) || failedTwitchIds.has(active.twitch_id)) continue;

      const channel = guild.channels.cache.get(active.channel_id);
      if (!channel || !channel.isTextBased()) {
        // The channel is gone or no longer text-based, so the message is
        // unreachable — drop the row (there is nothing left to clean up).
        logger.warn({ channel_id: active.channel_id, twitch_id: active.twitch_id }, 'Announcement channel missing or not text-based; dropping active stream');
        deleteActiveStreamByTwitchIdStatement.run(active.twitch_id);
        continue;
      }

      try {
        const message = await channel.messages.fetch(active.message_id);
        await message.delete();
        logger.info({ twitch_id: active.twitch_id, message_id: active.message_id }, 'Stream went offline, deleted announcement');
        // Success: the message is gone, so the row can go too.
        deleteActiveStreamByTwitchIdStatement.run(active.twitch_id);
      } catch (error) {
        const code = getDiscordErrorCode(error);
        if (code === DISCORD_ERROR_UNKNOWN_MESSAGE || code === DISCORD_ERROR_UNKNOWN_CHANNEL) {
          // The message/channel already doesn't exist — nothing to delete, drop the row.
          logger.debug({ message_id: active.message_id, code }, 'Message already gone, removing from DB');
          deleteActiveStreamByTwitchIdStatement.run(active.twitch_id);
        } else {
          // Transient or permission error (e.g. missing Manage Messages, 500):
          // keep the row so the next cycle retries instead of orphaning the message.
          logger.error({ err: error, twitch_id: active.twitch_id }, 'Failed to delete announcement; keeping row to retry next cycle');
        }
      }
    }

    // Handle online streams (post or update message)
    const channel = guild.channels.cache.get(channelId);
    if (!channel || !channel.isTextBased()) {
      // Misconfigured/missing DISCORD_CHANNEL_ID, or the bot lost View Channel:
      // log loudly (once per cycle) rather than silently skipping all announcements.
      logger.warn({ channel_id: channelId }, 'Announcement channel not found or not text-based; skipping online announcements this cycle');
      return;
    }

    // Fetch user profiles for avatars (cached; cache misses are batched into one request)
    const userProfileMap = await getUserProfiles(liveStreams.map(stream => stream.user_id));

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
          await message.edit({ embeds: [embed] });
          botLogger.info({ twitch_id: twitchId, twitch_username: username, message_id: active.message_id }, 'Stream announcement updated');
        } catch (error) {
          const code = getDiscordErrorCode(error);
          if (code === DISCORD_ERROR_UNKNOWN_MESSAGE || code === DISCORD_ERROR_UNKNOWN_CHANNEL) {
            // The original message/channel is gone — drop the row so a fresh
            // announcement is posted next cycle.
            botLogger.warn({ twitch_id: twitchId, twitch_username: username, code }, 'Announcement message missing; will re-post next cycle');
            deleteActiveStreamByTwitchIdStatement.run(twitchId);
          } else {
            // Transient/permission error: keep the row so we don't post a
            // duplicate while the old message still sits in the channel.
            botLogger.error({ err: error, twitch_username: username }, 'Failed to update announcement; keeping row to avoid duplicate');
          }
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
