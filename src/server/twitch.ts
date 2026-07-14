import { logger } from './logger.js';

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
const MAX_RATE_LIMIT_WAIT_MS = 30_000; // Cap so a far-future reset header can't stall a cycle

/**
 * Computes how long to wait before retrying a 429, based on the
 * Ratelimit-Reset header (a Unix timestamp in seconds). Returns 0 when there is
 * no usable header so the caller can fall back to exponential backoff. The
 * actual sleep happens in fetchWithRetry — this function only reads the header.
 */
function getRateLimitWaitMs(response: Response): number {
  if (response.status !== 429) return 0;

  const resetHeader = response.headers.get(RATE_LIMIT_RESET_HEADER);
  if (!resetHeader) return 0;

  const resetTime = Number(resetHeader);
  if (Number.isNaN(resetTime)) return 0;

  // +1s cushion past the reset instant to avoid racing the window boundary.
  const waitTime = (resetTime * 1000) - Date.now() + 1000;
  if (waitTime <= 0) return 0;

  return Math.min(waitTime, MAX_RATE_LIMIT_WAIT_MS);
}

/**
 * Wraps a Twitch API fetch with automatic retry. Retries 429 (respecting the
 * Ratelimit-Reset header, else exponential backoff), 5xx server errors, and
 * network/parse errors. Fails fast on 401 (auth) and other 4xx client errors,
 * which retrying cannot fix. Does NOT make test API calls to check rate limit
 * status.
 */
async function fetchWithRetry<T>(
  operation: string,
  url: string,
  fetchFunction: () => Promise<Response>,
  parseFunction: (data: unknown) => T
): Promise<T> {
  let lastNonRateLimitError: Error | undefined;
  
  for (let attempt = 0; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
    try {
      if (attempt === 0) {
        logger.debug({ operation, url }, 'Twitch API request sent');
      }
      const response = await fetchFunction();
      
      if (response.ok) {
        logger.debug({ operation, status: response.status, url }, 'Twitch API response received');
        const data = await response.json() as T;
        return parseFunction(data);
      }
      
      // Auth failure: do not retry, clear token and fail immediately
      if (response.status === 401) {
        logger.warn({ operation, status: response.status }, 'Twitch API authentication failed');
        clearTwitchToken();
        throw new TwitchApiError('Twitch authentication failed', response.status);
      }
      
      // Rate limit (429): wait and retry
      if (response.status === 429 && attempt < MAX_RETRY_ATTEMPTS) {
        const resetWaitMs = getRateLimitWaitMs(response);
        if (resetWaitMs > 0) {
          // Honor the server's reset window before retrying.
          logger.warn({ operation, wait_time_ms: resetWaitMs, attempt: attempt + 1, max_attempts: MAX_RETRY_ATTEMPTS }, 'Twitch API rate limited, waiting for reset');
          await new Promise(resolve => setTimeout(resolve, resetWaitMs));
          continue;
        }
        // No reset header: use exponential backoff
        const backoffTime = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
        logger.warn({ operation, backoff_ms: backoffTime, attempt: attempt + 1, max_attempts: MAX_RETRY_ATTEMPTS }, 'Twitch API rate limited, retrying');
        await new Promise(resolve => setTimeout(resolve, backoffTime));
        continue;
      }
      
      // Server error (5xx): transient, retry with backoff before giving up.
      if (response.status >= 500 && attempt < MAX_RETRY_ATTEMPTS) {
        const backoffTime = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
        logger.warn({ operation, status: response.status, backoff_ms: backoffTime, attempt: attempt + 1, max_attempts: MAX_RETRY_ATTEMPTS }, 'Twitch API server error, retrying');
        await new Promise(resolve => setTimeout(resolve, backoffTime));
        continue;
      }

      // Non-retryable error (4xx, or a 5xx that exhausted its retries): throw.
      logger.warn({ operation, status: response.status, statusText: response.statusText }, 'Twitch API error');
      throw new TwitchApiError(
        `Twitch API error for ${operation}: ${response.statusText} (${response.status})`,
        response.status,
        response.headers
      );
    } catch (error) {
      // A TwitchApiError here is an already-classified HTTP failure (auth, an
      // exhausted 5xx, or a non-retryable 4xx) — the retry decision was made
      // above, so propagate it without another round of backoff. Only genuine
      // network/parse errors (not TwitchApiError) fall through to retry.
      if (error instanceof TwitchApiError) {
        throw error;
      }
      lastNonRateLimitError = error instanceof Error ? error : new Error(String(error));
      if (attempt < MAX_RETRY_ATTEMPTS) {
        const backoffTime = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
        logger.warn({ operation, error: lastNonRateLimitError.message, backoff_ms: backoffTime }, 'Error during API call, retrying');
        await new Promise(resolve => setTimeout(resolve, backoffTime));
      }
    }
  }
  
  throw lastNonRateLimitError ?? new TwitchApiError(`Failed to ${operation} after ${MAX_RETRY_ATTEMPTS} retries`);
}

// Token management with race condition protection
const tokenState: {
  accessToken: string;
  expiresAt: number;
  refreshPromise: Promise<string> | undefined;
} = {
  accessToken: '',
  expiresAt: 0,
  refreshPromise: undefined,
};

export function clearTwitchToken() {
  tokenState.accessToken = '';
  tokenState.expiresAt = 0;
  tokenState.refreshPromise = undefined;
}

export async function getTwitchToken() {
  // Prevent concurrent token refreshes
  if (tokenState.refreshPromise) {
    return tokenState.refreshPromise;
  }

  if (tokenState.accessToken && Date.now() < tokenState.expiresAt) {
    return tokenState.accessToken;
  }

  tokenState.refreshPromise = (async () => {
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
      
      const response = await fetch(url.href, {
        method: 'POST'
      });

      if (!response.ok) {
        throw new TwitchApiError('Failed to get Twitch token', response.status, response.headers);
      }

      const data = await response.json() as TwitchTokenResponse;
      tokenState.accessToken = data.access_token;
      tokenState.expiresAt = Date.now() + (data.expires_in - 300) * 1000;
      return tokenState.accessToken;
    } finally {
      tokenState.refreshPromise = undefined;
    }
  })();

  return tokenState.refreshPromise;
}

export async function getUsers(usernames: string[]) {
  if (usernames.length === 0) return [];
  
  const token = await getTwitchToken();
  const clientId = process.env.TWITCH_CLIENT_ID;
  const parameters = new URLSearchParams();
  for (const u of usernames) parameters.append('login', u);
  
  const url = `https://api.twitch.tv/helix/users?${parameters.toString()}`;
  
  return fetchWithRetry<TwitchUser[]>(
    'getUsers',
    url,
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
  const parameters = new URLSearchParams();
  parameters.set('first', '100');
  for (const id of userIds) parameters.append('user_id', id);

  const url = `https://api.twitch.tv/helix/streams?${parameters.toString()}`;
  
  return fetchWithRetry<TwitchStream[]>(
    'getStreamsByIds',
    url,
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
  const parameters = new URLSearchParams();
  for (const id of userIds) parameters.append('id', id);
  
  const url = `https://api.twitch.tv/helix/users?${parameters.toString()}`;
  
  return fetchWithRetry<TwitchUser[]>(
    'getUsersByIds',
    url,
    () => fetch(url, {
      headers: {
        'Client-ID': clientId!,
        'Authorization': `Bearer ${token}`
      }
    }),
    (data) => ((data as TwitchUsersResponse).data ?? [])
  );
}
