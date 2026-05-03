export interface TwitchStream {
  id: string;
  user_id: string;
  user_login: string;
  user_name: string;
  game_id: string;
  game_name: string;
  type: string;
  title: string;
  viewer_count: number;
  started_at: string;
  language: string;
  thumbnail_url: string;
  tag_ids: string[];
  tags: string[];
  is_mature: boolean;
}

export interface TwitchUser {
  id: string;
  login: string;
  display_name: string;
  type: string;
  broadcaster_type: string;
  description: string;
  profile_image_url: string;
  offline_image_url: string;
  view_count: number;
  created_at: string;
}

interface TwitchTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

interface TwitchStreamsResponse {
  data: TwitchStream[];
  pagination: {
    cursor?: string;
  };
}

interface TwitchUsersResponse {
  data: TwitchUser[];
}

// Custom error class for Twitch API errors
export class TwitchApiError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public headers?: Headers
  ) {
    super(message);
    this.name = 'TwitchApiError';
  }
}

// Rate limit handling constants
const RATE_LIMIT_RESET_HEADER = 'Ratelimit-Reset';
const MAX_RETRY_ATTEMPTS = 3;
const INITIAL_BACKOFF_MS = 1000;

/**
 * Handles Twitch API rate limits with exponential backoff.
 * Respects the Ratelimit-Reset header when available.
 */
async function handleRateLimit(response: Response, operation: string): Promise<void> {
  if (response.status !== 429) return;
  
  const resetHeader = response.headers.get(RATE_LIMIT_RESET_HEADER);
  if (resetHeader) {
    const resetTime = Number.parseInt(resetHeader, 10);
    const waitTime = (resetTime * 1000) - Date.now() + 1000;
    if (waitTime > 0) {
      console.warn(`Twitch API rate limited for ${operation}. Waiting ${waitTime}ms...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  } else {
    // Fallback: exponential backoff
    console.warn(`Twitch API rate limited for ${operation}. Using exponential backoff.`);
    for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
      const backoffTime = INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
      console.warn(`Retry ${attempt}/${MAX_RETRY_ATTEMPTS} in ${backoffTime}ms...`);
      await new Promise(resolve => setTimeout(resolve, backoffTime));
      
      // Try again after backoff
      const clientId = process.env.TWITCH_CLIENT_ID;
      if (clientId) {
        const testResponse = await fetch(`https://api.twitch.tv/helix/streams?user_id=test`, {
          headers: {
            'Client-ID': clientId,
            'Authorization': `Bearer ${await getTwitchToken()}`
          }
        });
        if (testResponse.ok) return;
      }
    }
    throw new TwitchApiError(`Twitch API rate limited after ${MAX_RETRY_ATTEMPTS} retries`);
  }
}

// Token management with race condition protection
let accessToken = '';
let tokenExpiresAt = 0;
let tokenRefreshPromise: Promise<string> | undefined;

export function clearTwitchToken() {
  accessToken = '';
  tokenExpiresAt = 0;
  tokenRefreshPromise = undefined;
}

export async function getTwitchToken() {
  // Prevent concurrent token refreshes
  if (tokenRefreshPromise) {
    return tokenRefreshPromise;
  }
  
  if (accessToken && Date.now() < tokenExpiresAt) {
    return accessToken;
  }
  
  tokenRefreshPromise = (async () => {
    try {
      const clientId = process.env.TWITCH_CLIENT_ID;
      const clientSecret = process.env.TWITCH_CLIENT_SECRET;

      if (!clientId || !clientSecret) {
        throw new TwitchApiError('Twitch credentials not configured in environment variables');
      }

      // Use URL API for safer URL construction
      const url = new URL('https://id.twitch.tv/oauth2/token');
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('client_secret', clientSecret);
      url.searchParams.set('grant_type', 'client_credentials');
      
      const response = await fetch(url.toString(), {
        method: 'POST'
      });

      if (!response.ok) {
        throw new TwitchApiError('Failed to get Twitch token', response.status, response.headers);
      }

      const data = await response.json() as TwitchTokenResponse;
      accessToken = data.access_token;
      tokenExpiresAt = Date.now() + (data.expires_in - 300) * 1000;
      return accessToken;
    } finally {
      tokenRefreshPromise = undefined;
    }
  })();
  
  return tokenRefreshPromise;
}

export async function getStreams(usernames: string[]) {
  if (usernames.length === 0) return [];
  
  const token = await getTwitchToken();
  const clientId = process.env.TWITCH_CLIENT_ID;
  
  const params = new URLSearchParams();
  for (const u of usernames) params.append('user_login', u);
  
  const response = await fetch(`https://api.twitch.tv/helix/streams?${params.toString()}`, {
    headers: {
      'Client-ID': clientId!,
      'Authorization': `Bearer ${token}`
    }
  });

  if (!response.ok) {
    if (response.status === 401) {
      clearTwitchToken();
      throw new TwitchApiError('Twitch authentication failed', response.status);
    }
    await handleRateLimit(response, 'getStreams');
    throw new TwitchApiError('Failed to fetch streams', response.status, response.headers);
  }

  const data = await response.json() as TwitchStreamsResponse;
  return data.data; // Array of stream objects
}

export async function getUsers(usernames: string[]) {
  if (usernames.length === 0) return [];
  
  const token = await getTwitchToken();
  const clientId = process.env.TWITCH_CLIENT_ID;
  
  const params = new URLSearchParams();
  for (const u of usernames) params.append('login', u);
  
  const response = await fetch(`https://api.twitch.tv/helix/users?${params.toString()}`, {
    headers: {
      'Client-ID': clientId!,
      'Authorization': `Bearer ${token}`
    }
  });

  if (!response.ok) {
    if (response.status === 401) {
      clearTwitchToken();
      throw new TwitchApiError('Twitch authentication failed', response.status);
    }
    await handleRateLimit(response, 'getUsers');
    throw new TwitchApiError('Failed to fetch users', response.status, response.headers);
  }

  const data = await response.json() as TwitchUsersResponse;
  return data.data; // Array of user objects
}

export async function getStreamsByIds(userIds: string[]) {
  if (userIds.length === 0) return [];
  
  const token = await getTwitchToken();
  const clientId = process.env.TWITCH_CLIENT_ID;
  
  const params = new URLSearchParams();
  for (const id of userIds) params.append('user_id', id);
  
  const response = await fetch(`https://api.twitch.tv/helix/streams?${params.toString()}`, {
    headers: {
      'Client-ID': clientId!,
      'Authorization': `Bearer ${token}`
    }
  });

  if (!response.ok) {
    if (response.status === 401) {
      clearTwitchToken();
      throw new TwitchApiError('Twitch authentication failed', response.status);
    }
    await handleRateLimit(response, 'getStreamsByIds');
    throw new TwitchApiError('Failed to fetch streams by ID', response.status, response.headers);
  }

  const data = await response.json() as TwitchStreamsResponse;
  return data.data; // Array of stream objects
}

export async function getUsersByIds(userIds: string[]) {
  if (userIds.length === 0) return [];
  
  const token = await getTwitchToken();
  const clientId = process.env.TWITCH_CLIENT_ID;
  
  const params = new URLSearchParams();
  for (const id of userIds) params.append('id', id);
  
  const response = await fetch(`https://api.twitch.tv/helix/users?${params.toString()}`, {
    headers: {
      'Client-ID': clientId!,
      'Authorization': `Bearer ${token}`
    }
  });

  if (!response.ok) {
    if (response.status === 401) {
      clearTwitchToken();
      throw new TwitchApiError('Twitch authentication failed', response.status);
    }
    await handleRateLimit(response, 'getUsersByIds');
    throw new TwitchApiError('Failed to fetch users by ID', response.status, response.headers);
  }

  const data = await response.json() as TwitchUsersResponse;
  return data.data; // Array of user objects
}
