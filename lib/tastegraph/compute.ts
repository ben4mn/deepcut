/**
 * Tastegraph scoring. Computes TasteSnapshot rows (per user, entity, window)
 * from raw Play history.
 *
 * For each window we aggregate plays (joined to their track) into per-TRACK and
 * per-ARTIST rows:
 *   - playCount   : number of plays, EXCLUDING skip-noise (skipped=true AND
 *                   msPlayed < 30s). TODO: those excluded plays should later
 *                   feed a negative "skip signal".
 *   - msPlayed    : total ms listened
 *   - playPctAvg  : avg(min(msPlayed/durationMs, 1)) over plays with both values
 *   - score       : playCount * (0.5 + 0.5 * (playPctAvg ?? 0.75))
 *
 * GENRE snapshots are skipped for v0 — Artist.genres is empty until we add
 * enrichment. TODO: aggregate genre snapshots once genres are populated.
 *
 * Snapshots are fully derived, so each run deletes and recreates all rows for a
 * given (user, window) inside a transaction.
 */

import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { WINDOWS, windowStart, windowEnd, type Window } from "@/lib/tastegraph/windows";

const DEFAULT_PLAY_PCT = 0.75;

interface AggRow {
  entityId: string;
  playCount: number;
  msPlayed: bigint;
  playPctAvg: number | null;
}

/** Score from the raw aggregates. */
function scoreOf(playCount: number, playPctAvg: number | null): number {
  return playCount * (0.5 + 0.5 * (playPctAvg ?? DEFAULT_PLAY_PCT));
}

/** SQL fragment restricting plays to the given window's [start, end) range. */
function timeClause(window: string, now: Date): Prisma.Sql {
  const start = windowStart(window, now);
  if (start === null) {
    return Prisma.empty; // ALL — no lower bound
  }
  // Year windows have an exclusive upper bound; rolling/ALL end at `now`, and
  // plays can't be in the future, so no upper bound is needed for those.
  const isYear = /^Y\d{4}$/.test(window);
  if (isYear) {
    const end = windowEnd(window, now);
    return Prisma.sql`AND p."playedAt" >= ${start} AND p."playedAt" < ${end}`;
  }
  return Prisma.sql`AND p."playedAt" >= ${start}`;
}

async function aggregateTracks(
  userId: string,
  window: string,
  now: Date
): Promise<AggRow[]> {
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
      )::float8 AS "playPctAvg"
    FROM "Play" p
    JOIN "Track" t ON t.id = p."trackId"
    WHERE p."userId" = ${userId} ${timeClause(window, now)}
    GROUP BY t.id
  `;
}

async function aggregateArtists(
  userId: string,
  window: string,
  now: Date
): Promise<AggRow[]> {
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
      )::float8 AS "playPctAvg"
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
    score: scoreOf(r.playCount, r.playPctAvg),
  }));
}

export async function computeUserTastegraph(userId: string): Promise<void> {
  const now = new Date();
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

    // Snapshots are derived: replace the whole (user, window) set atomically.
    await db.$transaction([
      db.tasteSnapshot.deleteMany({ where: { userId, window } }),
      db.tasteSnapshot.createMany({ data: snapshotRows }),
    ]);
  }
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
