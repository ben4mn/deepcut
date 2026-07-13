import { db } from "../lib/db";
import { insertPlay, upsertTrack } from "../lib/ingest";
import {
  fetchRecentlyPlayed,
  getValidAccessTokenForUser,
  NotAllowlistedError,
  TokenExpiredError,
} from "../lib/spotify";

/**
 * Polls Spotify's "recently played" endpoint for every connected SpotifyAccount,
 * refreshing access tokens as needed and ingesting new Play rows via lib/ingest.
 * Per-user try/catch keeps one bad account from halting the fleet.
 */
export async function pollAllUsers(): Promise<void> {
  const accounts = await db.spotifyAccount.findMany({
    select: { userId: true, pollCursor: true },
  });

  if (accounts.length === 0) {
    console.log("[worker/poll] no connected accounts");
    return;
  }

  for (const account of accounts) {
    try {
      await pollUser(account.userId, account.pollCursor);
    } catch (err) {
      if (err instanceof NotAllowlistedError) {
        console.warn(`[worker/poll] user ${account.userId}: not allowlisted (403), skipping`);
      } else {
        console.error(`[worker/poll] user ${account.userId}: failed:`, err);
      }
    }
  }
}

async function pollUser(userId: string, pollCursor: bigint | null): Promise<void> {
  const afterMs = pollCursor !== null ? Number(pollCursor) : undefined;

  let accessToken = await getValidAccessTokenForUser(userId);
  let response;
  try {
    response = await fetchRecentlyPlayed(accessToken, afterMs);
  } catch (err) {
    // 401 despite a fresh-looking stored token — force a refresh and retry once.
    if (err instanceof TokenExpiredError) {
      accessToken = await getValidAccessTokenForUser(userId, true);
      response = await fetchRecentlyPlayed(accessToken, afterMs);
    } else {
      throw err;
    }
  }

  const items = response.items;
  if (items.length === 0) {
    await db.spotifyAccount.update({
      where: { userId },
      data: { lastPolledAt: new Date() },
    });
    console.log(`[worker/poll] user ${userId}: 0 new plays`);
    return;
  }

  // Spotify returns newest-first; process oldest → newest so the cursor only
  // ever advances past fully-ingested plays.
  const ordered = [...items].sort(
    (a, b) => new Date(a.played_at).getTime() - new Date(b.played_at).getTime()
  );

  let inserted = 0;
  let skipped = 0;
  let maxPlayedAtMs = afterMs ?? 0;

  for (const item of ordered) {
    const playedAt = new Date(item.played_at);
    const playedAtMs = playedAt.getTime();

    const trackId = await upsertTrack(db, {
      spotifyUri: item.track.uri,
      name: item.track.name,
      artistName: item.track.artists[0]?.name ?? "Unknown Artist",
      albumName: item.track.album?.name ?? null,
      durationMs: item.track.duration_ms ?? null,
    });

    const result = await insertPlay(db, {
      userId,
      trackId,
      playedAt,
      source: "POLL",
      context: item.context?.uri ?? null,
    });

    if (result.inserted) inserted += 1;
    else skipped += 1;

    if (playedAtMs > maxPlayedAtMs) maxPlayedAtMs = playedAtMs;
  }

  // Advance the cursor only after successfully processing the page.
  await db.spotifyAccount.update({
    where: { userId },
    data: {
      lastPolledAt: new Date(),
      pollCursor: BigInt(maxPlayedAtMs),
    },
  });

  console.log(
    `[worker/poll] user ${userId}: ${inserted} inserted, ${skipped} skipped (cursor → ${maxPlayedAtMs})`
  );
}
