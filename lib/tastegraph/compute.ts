/**
 * Tastegraph scoring pipeline (per user, nightly).
 *
 * Stages, in order (DESIGN §9 build order):
 *   1. sessionize   — reconstruct 30-min-gap listening sessions (persists Play.sessionId)
 *   2. calibration  — ListenerProfile meta-traits (§6.1), computed first so its
 *                     completionMultiplier normalizes everything downstream
 *   3. lifecycles   — per user+track TrackLifecycle rows: three clocks, quadrant,
 *                     burnout/resurrection, curve shape (§2–4, §6.3)
 *   4. snapshots    — the windowed TasteSnapshot aggregation the dashboard reads.
 *                     Kept intact (same columns), but its `score` is upgraded to a
 *                     Season-style EventValue-weighted sum (§1) instead of the flat
 *                     play-count heuristic.
 *
 * Snapshots stay fully derived: each run deletes and recreates all rows for a
 * given (user, window) inside a transaction.
 */

import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { WINDOWS, windowStart, windowEnd, type Window } from "@/lib/tastegraph/windows";
import { sessionizeUser } from "@/lib/tastegraph/sessionize";
import { computeListenerProfile } from "@/lib/tastegraph/calibration";
import { computeTrackLifecycles } from "@/lib/tastegraph/lifecycle";
import { generateAllPlaylists } from "@/lib/playlists";

const DEFAULT_PLAY_PCT = 0.75;

interface AggRow {
  entityId: string;
  playCount: number;
  msPlayed: bigint;
  playPctAvg: number | null;
  score: number;
}

/** SQL fragment restricting plays to the given window's [start, end) range. */
function timeClause(window: string, now: Date): Prisma.Sql {
  const start = windowStart(window, now);
  if (start === null) {
    return Prisma.empty; // ALL — no lower bound
  }
  const isYear = /^Y\d{4}$/.test(window);
  if (isYear) {
    const end = windowEnd(window, now);
    return Prisma.sql`AND p."playedAt" >= ${start} AND p."playedAt" < ${end}`;
  }
  return Prisma.sql`AND p."playedAt" >= ${start}`;
}

/**
 * Per-play EventValue approximation in SQL (DESIGN §1), summed into the snapshot
 * `score`. Mirrors lib/tastegraph/eventValue.ts (start weight × end factor ×
 * completion^0.7), but without decay — the window already bounds time — and
 * without the context bonuses (those need in-memory session reconstruction).
 * POLL rows (null reasons) land at ~0.9 × 0.9 × 0.85 ≈ 0.69, i.e. baseline.
 */
const EVENT_VALUE_SQL = Prisma.sql`
  (
    CASE p."reasonStart"
      WHEN 'backbtn'  THEN 2.0
      WHEN 'clickrow' THEN 1.5
      WHEN 'search'   THEN 1.5
      WHEN 'playbtn'  THEN 1.5
      WHEN 'trackdone' THEN 1.0
      ELSE 0.9
    END
    *
    CASE
      WHEN p."reasonEnd" ILIKE '%unexpected%' THEN 0.0
      WHEN p."reasonEnd" = 'trackdone' THEN 1.0
      WHEN p."reasonEnd" IN ('endplay','logout') THEN 0.9
      WHEN p."reasonEnd" = 'fwdbtn' AND p."msPlayed" IS NOT NULL AND t."durationMs" > 0
           AND (p."msPlayed"::float8 / t."durationMs") > 0.8 THEN 0.8
      WHEN p."reasonEnd" = 'fwdbtn' AND p."msPlayed" IS NOT NULL AND t."durationMs" > 0
           AND (p."msPlayed"::float8 / t."durationMs") < 0.25 AND p."msPlayed" < 60000 THEN -0.8
      WHEN p."reasonEnd" = 'fwdbtn' AND p."msPlayed" IS NOT NULL AND t."durationMs" > 0 THEN 0.1
      WHEN p."reasonEnd" = 'fwdbtn' THEN 0.5
      ELSE 0.9
    END
    *
    CASE
      WHEN p."msPlayed" IS NOT NULL AND t."durationMs" > 0
        THEN power(LEAST(p."msPlayed"::float8 / t."durationMs", 1), 0.7)
      ELSE 0.85
    END
  )
`;

async function aggregateTracks(userId: string, window: string, now: Date): Promise<AggRow[]> {
  return db.$queryRaw<AggRow[]>`
    SELECT
      t.id AS "entityId",
      SUM(CASE WHEN (p."skipped" = true AND p."msPlayed" < 30000) THEN 0 ELSE 1 END)::int AS "playCount",
      SUM(COALESCE(p."msPlayed", 0))::bigint AS "msPlayed",
      AVG(
        CASE
          WHEN p."msPlayed" IS NOT NULL AND t."durationMs" IS NOT NULL AND t."durationMs" > 0
          THEN LEAST(p."msPlayed"::float8 / t."durationMs", 1)
        END
      )::float8 AS "playPctAvg",
      SUM(${EVENT_VALUE_SQL})::float8 AS "score"
    FROM "Play" p
    JOIN "Track" t ON t.id = p."trackId"
    WHERE p."userId" = ${userId} ${timeClause(window, now)}
    GROUP BY t.id
  `;
}

async function aggregateArtists(userId: string, window: string, now: Date): Promise<AggRow[]> {
  // entityId = artistId when set, else the (denormalized) artistName.
  return db.$queryRaw<AggRow[]>`
    SELECT
      COALESCE(t."artistId", t."artistName") AS "entityId",
      SUM(CASE WHEN (p."skipped" = true AND p."msPlayed" < 30000) THEN 0 ELSE 1 END)::int AS "playCount",
      SUM(COALESCE(p."msPlayed", 0))::bigint AS "msPlayed",
      AVG(
        CASE
          WHEN p."msPlayed" IS NOT NULL AND t."durationMs" IS NOT NULL AND t."durationMs" > 0
          THEN LEAST(p."msPlayed"::float8 / t."durationMs", 1)
        END
      )::float8 AS "playPctAvg",
      SUM(${EVENT_VALUE_SQL})::float8 AS "score"
    FROM "Play" p
    JOIN "Track" t ON t.id = p."trackId"
    WHERE p."userId" = ${userId} ${timeClause(window, now)}
    GROUP BY COALESCE(t."artistId", t."artistName")
  `;
}

/** Distinct calendar years present in the user's play history, as Y#### windows. */
async function yearWindows(userId: string): Promise<Window[]> {
  const rows = await db.$queryRaw<{ year: number }[]>`
    SELECT DISTINCT EXTRACT(YEAR FROM p."playedAt")::int AS year
    FROM "Play" p
    WHERE p."userId" = ${userId}
    ORDER BY year
  `;
  return rows.map((r) => `Y${r.year}` as Window);
}

function toSnapshotRows(
  userId: string,
  window: string,
  entityType: "TRACK" | "ARTIST",
  rows: AggRow[]
): Prisma.TasteSnapshotCreateManyInput[] {
  return rows.map((r) => ({
    userId,
    entityType,
    entityId: r.entityId,
    window,
    playCount: r.playCount,
    msPlayed: r.msPlayed,
    playPctAvg: r.playPctAvg,
    // EventValue-weighted sum from SQL; guard nulls (empty aggregate) → 0.
    score: r.score ?? DEFAULT_PLAY_PCT * r.playCount,
  }));
}

/** Stage 4: the windowed TasteSnapshot aggregation the dashboard reads. */
async function computeSnapshots(userId: string, now: Date): Promise<void> {
  const windows: string[] = [...WINDOWS, ...(await yearWindows(userId))];

  for (const window of windows) {
    const [trackRows, artistRows] = await Promise.all([
      aggregateTracks(userId, window, now),
      aggregateArtists(userId, window, now),
    ]);

    const snapshotRows = [
      ...toSnapshotRows(userId, window, "TRACK", trackRows),
      ...toSnapshotRows(userId, window, "ARTIST", artistRows),
    ];

    await db.$transaction([
      db.tasteSnapshot.deleteMany({ where: { userId, window } }),
      db.tasteSnapshot.createMany({ data: snapshotRows }),
    ]);
  }
}

export async function computeUserTastegraph(userId: string): Promise<void> {
  const now = new Date();

  const t0 = Date.now();
  const session = await sessionizeUser(userId);
  const t1 = Date.now();
  const profile = await computeListenerProfile(userId);
  const t2 = Date.now();
  const lifecycleCount = await computeTrackLifecycles(userId, now, profile.completionMultiplier);
  const t3 = Date.now();
  await computeSnapshots(userId, now);
  const t4 = Date.now();
  const playlists = await generateAllPlaylists(userId, now);
  const t5 = Date.now();

  console.log(
    `[tastegraph/compute] user ${userId}: ` +
      `sessionize ${t1 - t0}ms (${session.sessionsFound} sessions, ${session.playsUpdated} plays updated), ` +
      `calibration ${t2 - t1}ms (restlessness ${profile.restlessness.toFixed(3)}, ` +
      `×${profile.completionMultiplier.toFixed(2)}), ` +
      `lifecycles ${t3 - t2}ms (${lifecycleCount} tracks), ` +
      `snapshots ${t4 - t3}ms, ` +
      `playlists ${t5 - t4}ms (${playlists.playlists} lists, ${playlists.items} items), ` +
      `total ${t5 - t0}ms`
  );
}

export async function computeAllTastegraphs(): Promise<void> {
  const users = await db.user.findMany({ select: { id: true } });
  for (const user of users) {
    try {
      await computeUserTastegraph(user.id);
    } catch (err) {
      console.error(`[tastegraph/compute] failed for user ${user.id}:`, err);
    }
  }
}
