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
 * Parses the Ratelimit-Reset header and waits if present.
 * Returns true if a wait was performed, false otherwise.
 */
function handleRateLimitHeader(response: Response): boolean {
  if (response.status !== 429) return false;
  
  const resetHeader = response.headers.get(RATE_LIMIT_RESET_HEADER);
  if (resetHeader) {
    const resetTime = Number.parseInt(resetHeader, 10);
    const waitTime = (resetTime * 1000) - Date.now() + 1000;
    if (waitTime > 0) {
      console.warn(`Twitch API rate limited. Waiting ${waitTime}ms until reset...`);
      return true;
    }
  }
  return false;
}

/**
 * Wraps a Twitch API fetch with automatic retry on 429 (rate limit).
 * Respects Ratelimit-Reset header and uses exponential backoff as fallback.
 * Does NOT make test API calls to check rate limit status.
 */
async function fetchWithRetry<T>(
  operation: string,
  fetchFn: () => Promise<Response>,
  parseFn: (data: unknown) => T
): Promise<T> {
  let lastNonRateLimitError: Error | undefined;
  
  for (let attempt = 0; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
    try {
      const response = await fetchFn();
      
      if (response.ok) {
        const data = await response.json() as T;
        return parseFn(data);
      }
      
      // Auth failure: do not retry, clear token and fail immediately
      if (response.status === 401) {
        clearTwitchToken();
        throw new TwitchApiError('Twitch authentication failed', response.status);
      }
      
      // Rate limit (429): wait and retry
      if (response.status === 429 && attempt < MAX_RETRY_ATTEMPTS) {
        if (handleRateLimitHeader(response)) {
          // Already waited for reset header, retry once
          continue;
        }
        // No reset header: use exponential backoff
        const backoffTime = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
        console.warn(`Twitch API rate limited for ${operation}. Retrying in ${backoffTime}ms (attempt ${attempt + 1}/${MAX_RETRY_ATTEMPTS})...`);
        await new Promise(resolve => setTimeout(resolve, backoffTime));
        continue;
      }
      
      // Non-retryable error: throw immediately
      throw new TwitchApiError(
        `Twitch API error for ${operation}: ${response.statusText} (${response.status})`,
        response.status,
        response.headers
      );
    } catch (error) {
      // Re-throw auth failures immediately
      if (error instanceof TwitchApiError && error.statusCode === 401) {
        throw error;
      }
      // For other errors (network, parse), retry with backoff
      lastNonRateLimitError = error instanceof Error ? error : new Error(String(error));
      if (attempt < MAX_RETRY_ATTEMPTS) {
        const backoffTime = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
        console.warn(`Error during ${operation}: ${lastNonRateLimitError.message}. Retrying in ${backoffTime}ms...`);
        await new Promise(resolve => setTimeout(resolve, backoffTime));
      }
    }
  }
  
  throw lastNonRateLimitError ?? new TwitchApiError(`Failed to ${operation} after ${MAX_RETRY_ATTEMPTS} retries`);
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
  
  const url = `https://api.twitch.tv/helix/streams?${params.toString()}`;
  
  return fetchWithRetry<TwitchStream[]>(
    'getStreams',
    () => fetch(url, {
      headers: {
        'Client-ID': clientId!,
        'Authorization': `Bearer ${token}`
      }
    }),
    (data) => ((data as TwitchStreamsResponse).data ?? [])
  );
}

export async function getUsers(usernames: string[]) {
  if (usernames.length === 0) return [];
  
  const token = await getTwitchToken();
  const clientId = process.env.TWITCH_CLIENT_ID;
  const params = new URLSearchParams();
  for (const u of usernames) params.append('login', u);
  
  const url = `https://api.twitch.tv/helix/users?${params.toString()}`;
  
  return fetchWithRetry<TwitchUser[]>(
    'getUsers',
    () => fetch(url, {
      headers: {
        'Client-ID': clientId!,
        'Authorization': `Bearer ${token}`
      }
    }),
    (data) => ((data as TwitchUsersResponse).data ?? [])
  );
}

export async function getStreamsByIds(userIds: string[]) {
  if (userIds.length === 0) return [];
  
  const token = await getTwitchToken();
  const clientId = process.env.TWITCH_CLIENT_ID;
  const params = new URLSearchParams();
  for (const id of userIds) params.append('user_id', id);
  
  const url = `https://api.twitch.tv/helix/streams?${params.toString()}`;
  
  return fetchWithRetry<TwitchStream[]>(
    'getStreamsByIds',
    () => fetch(url, {
      headers: {
        'Client-ID': clientId!,
        'Authorization': `Bearer ${token}`
      }
    }),
    (data) => ((data as TwitchStreamsResponse).data ?? [])
  );
}

export async function getUsersByIds(userIds: string[]) {
  if (userIds.length === 0) return [];
  
  const token = await getTwitchToken();
  const clientId = process.env.TWITCH_CLIENT_ID;
  const params = new URLSearchParams();
  for (const id of userIds) params.append('id', id);
  
  const url = `https://api.twitch.tv/helix/users?${params.toString()}`;
  
  return fetchWithRetry<TwitchUser[]>(
    'getUsersByIds',
    () => fetch(url, {
      headers: {
        'Client-ID': clientId!,
        'Authorization': `Bearer ${token}`
      }
    }),
    (data) => ((data as TwitchUsersResponse).data ?? [])
  );
}
