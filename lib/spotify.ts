import { db } from "./db";
import { decryptToken, encryptToken } from "./crypto";

/**
 * Spotify Web API client. Deliberately framework-free (no Next.js imports) so it
 * can run in both the App Router server and the standalone `tsx worker/...`
 * process. Only the endpoints Deepcut needs today live here: token refresh and
 * recently-played. No catalog endpoints.
 */

const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const SPOTIFY_API_BASE = "https://api.spotify.com/v1";
// Refresh proactively when the stored token is within this window of expiry.
const REFRESH_THRESHOLD_MS = 2 * 60 * 1000;

const RATE_LIMIT_STATUS = 429;
const UNAUTHORIZED_STATUS = 401;
const FORBIDDEN_STATUS = 403;

/** Thrown on a 401 so callers can force a refresh and retry once. */
export class TokenExpiredError extends Error {
  constructor(message = "Spotify access token expired") {
    super(message);
    this.name = "TokenExpiredError";
  }
}

/** Thrown on a 403 — the user isn't on this app's Spotify allowlist. */
export class NotAllowlistedError extends Error {
  constructor(message = "Spotify user not allowlisted (403)") {
    super(message);
    this.name = "NotAllowlistedError";
  }
}

export interface RefreshedToken {
  accessToken: string;
  // Spotify may omit a rotated refresh_token — caller keeps the old one.
  refreshToken?: string;
  expiresAt: number; // unix ms
  scope?: string;
}

interface SpotifyTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

/**
 * Exchanges a refresh token for a fresh access token via the client-credentials
 * Basic-auth flow. Shared by the JWT callback (auth.ts) and the worker.
 */
export async function refreshSpotifyToken(refreshTokenPlain: string): Promise<RefreshedToken> {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET are not set");
  }

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshTokenPlain,
  });

  const res = await fetch(SPOTIFY_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Spotify token refresh failed (${res.status}): ${text}`);
  }

  const json = (await res.json()) as SpotifyTokenResponse;
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + json.expires_in * 1000,
    scope: json.scope,
  };
}

/**
 * Returns a plain (decrypted) access token for the user, refreshing and
 * persisting rotated tokens (encrypted) if the stored one is expired or within
 * REFRESH_THRESHOLD_MS of expiry. Pass `force` to refresh unconditionally, e.g.
 * after the API answered 401 despite a not-yet-expired stored token.
 */
export async function getValidAccessTokenForUser(userId: string, force = false): Promise<string> {
  const account = await db.spotifyAccount.findUnique({ where: { userId } });
  if (!account) {
    throw new Error(`No SpotifyAccount for user ${userId}`);
  }

  if (!force && account.expiresAt.getTime() - Date.now() > REFRESH_THRESHOLD_MS) {
    return decryptToken(account.accessTokenEnc);
  }

  const refreshTokenPlain = decryptToken(account.refreshTokenEnc);
  const refreshed = await refreshSpotifyToken(refreshTokenPlain);
  const newRefresh = refreshed.refreshToken ?? refreshTokenPlain;

  await db.spotifyAccount.update({
    where: { userId },
    data: {
      accessTokenEnc: encryptToken(refreshed.accessToken),
      refreshTokenEnc: encryptToken(newRefresh),
      expiresAt: new Date(refreshed.expiresAt),
      ...(refreshed.scope ? { scope: refreshed.scope } : {}),
    },
  });

  return refreshed.accessToken;
}

export interface RecentlyPlayedArtist {
  name: string;
  uri: string;
}

export interface RecentlyPlayedTrack {
  uri: string;
  name: string;
  duration_ms: number;
  album: { name: string };
  artists: RecentlyPlayedArtist[];
}

export interface RecentlyPlayedItem {
  track: RecentlyPlayedTrack;
  played_at: string;
  context: { uri: string } | null;
}

export interface RecentlyPlayedResponse {
  items: RecentlyPlayedItem[];
}

/**
 * GET /me/player/recently-played (limit 50). `afterMs` is a unix-ms cursor —
 * Spotify returns only plays strictly after it. Retries once on 429 (honoring
 * Retry-After); throws TokenExpiredError on 401 and NotAllowlistedError on 403.
 */
export async function fetchRecentlyPlayed(
  accessToken: string,
  afterMs?: number
): Promise<RecentlyPlayedResponse> {
  const url = new URL(`${SPOTIFY_API_BASE}/me/player/recently-played`);
  url.searchParams.set("limit", "50");
  if (afterMs !== undefined) {
    url.searchParams.set("after", String(afterMs));
  }

  let retriedRateLimit = false;
  while (true) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (res.status === RATE_LIMIT_STATUS && !retriedRateLimit) {
      const retryAfter = Number.parseInt(res.headers.get("retry-after") ?? "1", 10) || 1;
      await sleep(retryAfter * 1000);
      retriedRateLimit = true;
      continue;
    }

    if (res.status === UNAUTHORIZED_STATUS) {
      throw new TokenExpiredError();
    }

    if (res.status === FORBIDDEN_STATUS) {
      throw new NotAllowlistedError();
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Spotify recently-played failed (${res.status}): ${text}`);
    }

    return (await res.json()) as RecentlyPlayedResponse;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
