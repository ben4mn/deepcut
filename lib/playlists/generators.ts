/**
 * Playlist generators (DESIGN §7 portfolio — the "ship first" core rotation plus
 * the One-Artist Era flagship). Every rule here is computable from fields we
 * already have: TrackLifecycle (three clocks, quadrant, burnout, honeymoon),
 * raw Play rows, and their timestamps/reasons.
 *
 * Design/scale notes:
 *   - A user can have ~300k plays, so the heavy work is done as *grouped* SQL
 *     aggregates (one pass over Play per query, on the [userId, playedAt] index),
 *     never a 300k-row load. The only per-play loads are timestamp streams for a
 *     small candidate set (tracks with ≥8 lifetime plays) used by the two
 *     window-shape playlists (One Night Only, Comeback Kids).
 *   - TrackLifecycle rows (one per user+track) are loaded once and shared.
 *   - Burnout guard (§7): tracks that are burned with an active cooldown are
 *     excluded from the *current-rotation* lists (Top All Time — explicit in the
 *     task — plus Heavy Rotation, Full Send, New Blood). Time-capsule / historical
 *     lists (One Night Only, Gateway Drugs, This Week Every Year, One-Artist Era)
 *     and the revival lists (Comeback Kids, Resurrection) intentionally do NOT
 *     apply the cooldown, since they are about the past or about reviving a
 *     dormant track.
 *
 * Each generator returns zero or more PlaylistSpec objects. generateAllPlaylists
 * (lib/playlists/index.ts) persists them with a delete-and-recreate per (user,
 * kind) in a transaction.
 */

import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

const DAY_MS = 86_400_000;

/** Max items in any single generated playlist. */
export const MAX_ITEMS = 50;

export type PlaylistKind =
  | "TOP_ALL_TIME"
  | "HEAVY_ROTATION"
  | "FULL_SEND"
  | "ONE_NIGHT_ONLY"
  | "GATEWAY_DRUGS"
  | "THIS_WEEK_EVERY_YEAR"
  | "COMEBACK_KIDS"
  | "RESURRECTION"
  | "ONE_HIT_WONDER"
  | "NEW_BLOOD"
  | "ON_THE_WAY_OUT"
  | "ONE_ARTIST_ERA";

export interface PlaylistItemSpec {
  trackId: string;
  position: number;
  stat: string | null;
}

export interface PlaylistSpec {
  kind: PlaylistKind;
  title: string;
  description: string;
  meta?: Prisma.InputJsonValue;
  items: PlaylistItemSpec[];
}

/** Per user+track lifecycle projection shared across generators. */
interface Lc {
  trackId: string;
  artistKey: string; // artistId when known, else artistName
  artistName: string;
  coreScore: number;
  pulseScore: number;
  seasonScore: number;
  lifetimePlays: number;
  firstPlayAt: Date;
  lastPlayAt: Date;
  burned: boolean;
  cooldownUntil: Date | null;
  resurrectionEligible: boolean;
  honeymoonSlope: number | null;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function monthYear(d: Date): string {
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function fmtDay(d: Date): string {
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/** Meteorological season (northern-hemisphere naming) + year of a date. */
function seasonYear(d: Date): string {
  const m = d.getUTCMonth();
  const y = d.getUTCFullYear();
  if (m === 11) return `Winter ${y}`;
  if (m <= 1) return `Winter ${y}`;
  if (m <= 4) return `Spring ${y}`;
  if (m <= 7) return `Summer ${y}`;
  return `Autumn ${y}`;
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** Whether a burned track is still inside its 90-day cooldown at `now`. */
function isCooling(lc: Lc, now: Date): boolean {
  return lc.burned && lc.cooldownUntil !== null && lc.cooldownUntil.getTime() > now.getTime();
}

// ---------------------------------------------------------------------------
// Shared loaders
// ---------------------------------------------------------------------------

/** Loads all TrackLifecycle rows for the user (one per track), with artist keys. */
async function loadLifecycles(userId: string): Promise<Lc[]> {
  const rows = await db.trackLifecycle.findMany({
    where: { userId },
    select: {
      trackId: true,
      coreScore: true,
      pulseScore: true,
      seasonScore: true,
      lifetimePlays: true,
      firstPlayAt: true,
      lastPlayAt: true,
      burned: true,
      cooldownUntil: true,
      resurrectionEligible: true,
      honeymoonSlope: true,
      track: { select: { artistId: true, artistName: true } },
    },
  });
  return rows.map((r) => ({
    trackId: r.trackId,
    artistKey: r.track.artistId ?? r.track.artistName,
    artistName: r.track.artistName,
    coreScore: r.coreScore,
    pulseScore: r.pulseScore,
    seasonScore: r.seasonScore,
    lifetimePlays: r.lifetimePlays,
    firstPlayAt: r.firstPlayAt,
    lastPlayAt: r.lastPlayAt,
    burned: r.burned,
    cooldownUntil: r.cooldownUntil,
    resurrectionEligible: r.resurrectionEligible,
    honeymoonSlope: r.honeymoonSlope,
  }));
}

/** Per-track play count over the trailing `days` days (grouped SQL). */
async function playCountsSince(
  userId: string,
  since: Date
): Promise<Map<string, number>> {
  const rows = await db.$queryRaw<{ trackId: string; c: number }[]>`
    SELECT p."trackId" AS "trackId", COUNT(*)::int AS c
    FROM "Play" p
    WHERE p."userId" = ${userId} AND p."playedAt" >= ${since}
    GROUP BY p."trackId"
  `;
  return new Map(rows.map((r) => [r.trackId, r.c]));
}

const TS_CHUNK = 500;

/**
 * Streams (trackId, playedAt ms) for a bounded set of tracks, ordered by track
 * then time. Used only for the small "≥8 lifetime plays" candidate set.
 */
async function loadTimestamps(
  userId: string,
  trackIds: string[]
): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  for (let i = 0; i < trackIds.length; i += TS_CHUNK) {
    const chunk = trackIds.slice(i, i + TS_CHUNK);
    const rows = await db.$queryRaw<{ trackId: string; playedAt: Date }[]>`
      SELECT p."trackId" AS "trackId", p."playedAt" AS "playedAt"
      FROM "Play" p
      WHERE p."userId" = ${userId} AND p."trackId" IN (${Prisma.join(chunk)})
      ORDER BY p."trackId", p."playedAt"
    `;
    for (const r of rows) {
      const arr = out.get(r.trackId) ?? [];
      arr.push(r.playedAt.getTime());
      out.set(r.trackId, arr);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Top 50 by Core-clock score, burnout-guarded. */
function genTopAllTime(lcs: Lc[], now: Date): PlaylistSpec[] {
  const items = lcs
    .filter((lc) => !isCooling(lc, now))
    .sort((a, b) => b.coreScore - a.coreScore)
    .slice(0, MAX_ITEMS)
    .map((lc, i) => ({
      trackId: lc.trackId,
      position: i,
      stat: plural(lc.lifetimePlays, "play"),
    }));
  if (items.length === 0) return [];
  return [
    {
      kind: "TOP_ALL_TIME",
      title: "Top Songs of All Time",
      description: "Your canon — the tracks that define you, on the 2-year Core clock.",
      items,
    },
  ];
}

/** Top 50 by Pulse-clock score, min 2 plays in the last 14 days. */
function genHeavyRotation(
  lcs: Lc[],
  last14: Map<string, number>,
  now: Date
): PlaylistSpec[] {
  const items = lcs
    .filter((lc) => !isCooling(lc, now) && (last14.get(lc.trackId) ?? 0) >= 2)
    .sort((a, b) => b.pulseScore - a.pulseScore)
    .slice(0, MAX_ITEMS)
    .map((lc, i) => ({
      trackId: lc.trackId,
      position: i,
      stat: `${plural(last14.get(lc.trackId) ?? 0, "play")} in the last 2 weeks`,
    }));
  if (items.length === 0) return [];
  return [
    {
      kind: "HEAVY_ROTATION",
      title: "Heavy Rotation",
      description: "What you're on right now — top of the 14-day Pulse clock.",
      items,
    },
  ];
}

interface FullSendRow {
  trackId: string;
  plays: number;
  meanCompletion: number | null;
  earlySkips: number;
}

/** ≥15 plays, zero early-skips, mean completion ≥0.98. Ordered by plays. */
async function genFullSend(userId: string, coolingSet: Set<string>): Promise<PlaylistSpec[]> {
  const rows = await db.$queryRaw<FullSendRow[]>`
    SELECT
      p."trackId" AS "trackId",
      COUNT(*)::int AS "plays",
      AVG(
        CASE WHEN p."msPlayed" IS NOT NULL AND t."durationMs" > 0
          THEN LEAST(p."msPlayed"::float8 / t."durationMs", 1) END
      )::float8 AS "meanCompletion",
      SUM(
        CASE WHEN p."reasonEnd" = 'fwdbtn' AND p."msPlayed" IS NOT NULL
          AND t."durationMs" > 0 AND (p."msPlayed"::float8 / t."durationMs") < 0.25
          THEN 1 ELSE 0 END
      )::int AS "earlySkips"
    FROM "Play" p JOIN "Track" t ON t.id = p."trackId"
    WHERE p."userId" = ${userId}
    GROUP BY p."trackId"
    HAVING COUNT(*) >= 15
  `;

  const items = rows
    .filter(
      (r) =>
        r.earlySkips === 0 &&
        r.meanCompletion !== null &&
        r.meanCompletion >= 0.98 &&
        !coolingSet.has(r.trackId)
    )
    .sort((a, b) => b.plays - a.plays)
    .slice(0, MAX_ITEMS)
    .map((r, i) => ({
      trackId: r.trackId,
      position: i,
      stat: `${r.plays} plays · 0 skips`,
    }));

  if (items.length === 0) return [];
  return [
    {
      kind: "FULL_SEND",
      title: "Full Send",
      description: "Songs you have never once skipped. Play, after play, after play.",
      items,
    },
  ];
}

/**
 * ≥8 plays inside a single 24h window that account for ≥90% of lifetime plays.
 * Uses a two-pointer sliding window over each candidate track's timestamps.
 */
async function genOneNightOnly(
  userId: string,
  lcs: Lc[]
): Promise<PlaylistSpec[]> {
  const candidates = lcs.filter((lc) => lc.lifetimePlays >= 8);
  if (candidates.length === 0) return [];

  const ts = await loadTimestamps(
    userId,
    candidates.map((c) => c.trackId)
  );

  interface Hit {
    trackId: string;
    windowPlays: number;
    peakStartMs: number;
  }
  const hits: Hit[] = [];

  for (const lc of candidates) {
    const times = ts.get(lc.trackId);
    if (!times || times.length < 8) continue;
    // Sliding 24h window: max plays inside any [t, t+24h).
    let best = 0;
    let bestStart = times[0];
    let lo = 0;
    for (let hi = 0; hi < times.length; hi++) {
      while (times[hi] - times[lo] >= DAY_MS) lo++;
      const count = hi - lo + 1;
      if (count > best) {
        best = count;
        bestStart = times[lo];
      }
    }
    if (best >= 8 && best >= 0.9 * lc.lifetimePlays) {
      hits.push({ trackId: lc.trackId, windowPlays: best, peakStartMs: bestStart });
    }
  }

  const items = hits
    .sort((a, b) => b.windowPlays - a.windowPlays)
    .slice(0, MAX_ITEMS)
    .map((h, i) => ({
      trackId: h.trackId,
      position: i,
      stat: `${plural(h.windowPlays, "play")} on ${fmtDay(new Date(h.peakStartMs))}, never again`,
    }));

  if (items.length === 0) return [];
  return [
    {
      kind: "ONE_NIGHT_ONLY",
      title: "On Repeat, One Night Only",
      description: "Songs you binged in a single day — and then never returned to.",
      items,
    },
  ];
}

/** Earliest-played track per top-50 artist (by summed Core), chronological. */
function genGatewayDrugs(lcs: Lc[]): PlaylistSpec[] {
  // Aggregate Core score per artist and remember each artist's earliest track.
  const coreByArtist = new Map<string, number>();
  const earliestByArtist = new Map<string, Lc>();
  for (const lc of lcs) {
    coreByArtist.set(lc.artistKey, (coreByArtist.get(lc.artistKey) ?? 0) + lc.coreScore);
    const cur = earliestByArtist.get(lc.artistKey);
    if (!cur || lc.firstPlayAt.getTime() < cur.firstPlayAt.getTime()) {
      earliestByArtist.set(lc.artistKey, lc);
    }
  }

  const topArtists = [...coreByArtist.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_ITEMS)
    .map(([key]) => key);

  const gateways = topArtists
    .map((key) => earliestByArtist.get(key)!)
    .filter(Boolean)
    .sort((a, b) => a.firstPlayAt.getTime() - b.firstPlayAt.getTime());

  const items = gateways.slice(0, MAX_ITEMS).map((lc, i) => ({
    trackId: lc.trackId,
    position: i,
    stat: `your way into ${lc.artistName}, ${monthYear(lc.firstPlayAt)}`,
  }));

  if (items.length === 0) return [];
  return [
    {
      kind: "GATEWAY_DRUGS",
      title: "Gateway Drugs",
      description: "The first song you ever played by each of your favorite artists.",
      items,
    },
  ];
}

interface WeekYearRow {
  yr: number;
  trackId: string;
  c: number;
}

/** Top tracks from this ISO-week (±3d) in each past year, grouped chronologically. */
async function genThisWeekEveryYear(userId: string, now: Date): Promise<PlaylistSpec[]> {
  const targetDoy = dayOfYear(now);
  const curYear = now.getUTCFullYear();
  const PER_YEAR = 8;

  const rows = await db.$queryRaw<WeekYearRow[]>`
    SELECT
      EXTRACT(YEAR FROM p."playedAt")::int AS "yr",
      p."trackId" AS "trackId",
      COUNT(*)::int AS "c"
    FROM "Play" p
    WHERE p."userId" = ${userId}
      AND LEAST(
            abs(EXTRACT(DOY FROM p."playedAt")::int - ${targetDoy}),
            365 - abs(EXTRACT(DOY FROM p."playedAt")::int - ${targetDoy})
          ) <= 3
    GROUP BY "yr", p."trackId"
  `;

  // Group by year, keep top PER_YEAR tracks each, then emit oldest-year first.
  const byYear = new Map<number, WeekYearRow[]>();
  for (const r of rows) {
    if (r.yr >= curYear) continue;
    const arr = byYear.get(r.yr) ?? [];
    arr.push(r);
    byYear.set(r.yr, arr);
  }

  const years = [...byYear.keys()].sort((a, b) => a - b);
  const items: PlaylistItemSpec[] = [];
  let pos = 0;
  for (const yr of years) {
    const top = byYear
      .get(yr)!
      .sort((a, b) => b.c - a.c)
      .slice(0, PER_YEAR);
    for (const r of top) {
      if (pos >= MAX_ITEMS) break;
      items.push({ trackId: r.trackId, position: pos++, stat: `${yr}` });
    }
    if (pos >= MAX_ITEMS) break;
  }

  if (items.length === 0) return [];
  return [
    {
      kind: "THIS_WEEK_EVERY_YEAR",
      title: "This Week, Every Year",
      description: "What you were listening to this same week across the years.",
      items,
    },
  ];
}

/**
 * Dormant ≥270d before a return, and the current 28-day rate beats the pre-gap
 * peak 28-day rate. Needs per-track timestamps (bounded candidate set).
 */
async function genComebackKids(
  userId: string,
  lcs: Lc[],
  now: Date
): Promise<PlaylistSpec[]> {
  const nowMs = now.getTime();
  // Candidates: enough plays to have a "peak", and active in the last 28 days.
  const cutoff = nowMs - 28 * DAY_MS;
  const candidates = lcs.filter(
    (lc) => lc.lifetimePlays >= 8 && lc.lastPlayAt.getTime() >= cutoff
  );
  if (candidates.length === 0) return [];

  const ts = await loadTimestamps(
    userId,
    candidates.map((c) => c.trackId)
  );

  interface Hit {
    trackId: string;
    currentRate: number;
    priorEraYear: number;
  }
  const hits: Hit[] = [];

  for (const lc of candidates) {
    const times = ts.get(lc.trackId);
    if (!times || times.length < 8) continue;

    // Find the last inter-play gap ≥270d — the "return".
    let returnIdx = -1;
    for (let i = 1; i < times.length; i++) {
      if (times[i] - times[i - 1] >= 270 * DAY_MS) returnIdx = i;
    }
    if (returnIdx < 1) continue;

    const priorTimes = times.slice(0, returnIdx);
    const peakPrior = peakRate28d(priorTimes);
    const currentRate = countInWindow(times, nowMs - 28 * DAY_MS, nowMs);
    if (currentRate > peakPrior && currentRate > 0) {
      hits.push({
        trackId: lc.trackId,
        currentRate,
        priorEraYear: new Date(priorTimes[priorTimes.length - 1]).getUTCFullYear(),
      });
    }
  }

  const items = hits
    .sort((a, b) => b.currentRate - a.currentRate)
    .slice(0, MAX_ITEMS)
    .map((h, i) => ({
      trackId: h.trackId,
      position: i,
      stat: `back, and bigger than ${h.priorEraYear}`,
    }));

  if (items.length === 0) return [];
  return [
    {
      kind: "COMEBACK_KIDS",
      title: "Comeback Kids",
      description: "Songs you'd left for dead — back harder than their first run.",
      items,
    },
  ];
}

/** Resurrection-eligible tracks (dormant ≥180d, Core ≥p70, not burned). */
function genResurrection(lcs: Lc[]): PlaylistSpec[] {
  const items = lcs
    .filter((lc) => lc.resurrectionEligible)
    .sort((a, b) => b.coreScore - a.coreScore)
    .slice(0, MAX_ITEMS)
    .map((lc, i) => ({
      trackId: lc.trackId,
      position: i,
      stat: `last played ${monthYear(lc.lastPlayAt)} — remember this?`,
    }));
  if (items.length === 0) return [];
  return [
    {
      kind: "RESURRECTION",
      title: "Resurrection Machine",
      description: "Old favorites you haven't heard in ages, cued back up.",
      items,
    },
  ];
}

/** Artists whose single track is 100% of ≥25 lifetime artist plays. */
function genOneHitWonder(lcs: Lc[]): PlaylistSpec[] {
  const byArtist = new Map<string, Lc[]>();
  for (const lc of lcs) {
    const arr = byArtist.get(lc.artistKey) ?? [];
    arr.push(lc);
    byArtist.set(lc.artistKey, arr);
  }

  const hits: Lc[] = [];
  for (const tracks of byArtist.values()) {
    if (tracks.length !== 1) continue; // one track = 100% of the artist
    const only = tracks[0];
    if (only.lifetimePlays >= 25) hits.push(only);
  }

  const items = hits
    .sort((a, b) => b.lifetimePlays - a.lifetimePlays)
    .slice(0, MAX_ITEMS)
    .map((lc, i) => ({
      trackId: lc.trackId,
      position: i,
      stat: `${plural(lc.lifetimePlays, "play")}, and the only ${lc.artistName} song you know`,
    }));

  if (items.length === 0) return [];
  return [
    {
      kind: "ONE_HIT_WONDER",
      title: "One-Hit Wonder (By You)",
      description: "Artists you know exactly one song by — and play it into the ground.",
      items,
    },
  ];
}

/** First play ≤60d ago, positive honeymoon slope, ≥5 plays. */
function genNewBlood(lcs: Lc[], now: Date): PlaylistSpec[] {
  const cutoff = now.getTime() - 60 * DAY_MS;
  const items = lcs
    .filter(
      (lc) =>
        !isCooling(lc, now) &&
        lc.firstPlayAt.getTime() >= cutoff &&
        (lc.honeymoonSlope ?? 0) > 0 &&
        lc.lifetimePlays >= 5
    )
    .sort((a, b) => b.pulseScore - a.pulseScore)
    .slice(0, MAX_ITEMS)
    .map((lc, i) => ({
      trackId: lc.trackId,
      position: i,
      stat: `${plural(lc.lifetimePlays, "play")} since ${monthYear(lc.firstPlayAt)}`,
    }));
  if (items.length === 0) return [];
  return [
    {
      kind: "NEW_BLOOD",
      title: "New Blood",
      description: "Songs you just discovered and are already falling for.",
      items,
    },
  ];
}

interface FadeRow {
  trackId: string;
  recent28: number;
  past28: number;
  last30: number;
}

/**
 * Fading: current 28d rate < 0.5 × the 28d window ending 90d ago, still alive
 * (≥1 play in the last 30d). Approximates the "seasonScore dropped" signal.
 */
async function genOnTheWayOut(userId: string, now: Date): Promise<PlaylistSpec[]> {
  const nowMs = now.getTime();
  const d28 = new Date(nowMs - 28 * DAY_MS);
  const d30 = new Date(nowMs - 30 * DAY_MS);
  const d90 = new Date(nowMs - 90 * DAY_MS);
  const d118 = new Date(nowMs - 118 * DAY_MS);

  const rows = await db.$queryRaw<FadeRow[]>`
    SELECT
      p."trackId" AS "trackId",
      SUM(CASE WHEN p."playedAt" >= ${d28} THEN 1 ELSE 0 END)::int AS "recent28",
      SUM(CASE WHEN p."playedAt" >= ${d118} AND p."playedAt" < ${d90} THEN 1 ELSE 0 END)::int AS "past28",
      SUM(CASE WHEN p."playedAt" >= ${d30} THEN 1 ELSE 0 END)::int AS "last30"
    FROM "Play" p
    WHERE p."userId" = ${userId} AND p."playedAt" >= ${d118}
    GROUP BY p."trackId"
    HAVING SUM(CASE WHEN p."playedAt" >= ${d118} AND p."playedAt" < ${d90} THEN 1 ELSE 0 END) > 0
  `;

  const items = rows
    .filter((r) => r.last30 >= 1 && r.recent28 < 0.5 * r.past28)
    .sort((a, b) => b.past28 - a.past28)
    .slice(0, MAX_ITEMS)
    .map((r, i) => ({
      trackId: r.trackId,
      position: i,
      stat: `fading — ${r.past28} plays a season ago, ${r.recent28} now`,
    }));

  if (items.length === 0) return [];
  return [
    {
      kind: "ON_THE_WAY_OUT",
      title: "On the Way Out",
      description: "Last call — songs slipping out of your rotation.",
      items,
    },
  ];
}

interface DailyArtistRow {
  day: Date;
  artistKey: string;
  c: number;
}

interface EraCandidate {
  artistKey: string;
  startMs: number;
  endMs: number;
  share: number;
  windowPlays: number;
}

/**
 * One-Artist Era (DESIGN §7 flagship). Sweeps 90-day windows (step 30d) over the
 * user's history; any window with ≥100 plays where a single artist has ≥25%
 * share becomes an era. Overlapping windows for the same artist are merged, and
 * the top 3 eras by share become playlists.
 */
async function genOneArtistEra(
  userId: string,
  lcs: Lc[],
  now: Date
): Promise<PlaylistSpec[]> {
  const daily = await db.$queryRaw<DailyArtistRow[]>`
    SELECT
      date_trunc('day', p."playedAt") AS "day",
      COALESCE(t."artistId", t."artistName") AS "artistKey",
      COUNT(*)::int AS "c"
    FROM "Play" p JOIN "Track" t ON t.id = p."trackId"
    WHERE p."userId" = ${userId}
    GROUP BY "day", COALESCE(t."artistId", t."artistName")
    ORDER BY "day"
  `;
  if (daily.length === 0) return [];

  // Bucket per UTC-day: total plays + per-artist plays.
  const dayTotals = new Map<number, number>();
  const dayArtists = new Map<number, Map<string, number>>();
  let minDay = Infinity;
  let maxDay = -Infinity;
  for (const r of daily) {
    const dayIdx = Math.floor(r.day.getTime() / DAY_MS);
    minDay = Math.min(minDay, dayIdx);
    maxDay = Math.max(maxDay, dayIdx);
    dayTotals.set(dayIdx, (dayTotals.get(dayIdx) ?? 0) + r.c);
    const am = dayArtists.get(dayIdx) ?? new Map<string, number>();
    am.set(r.artistKey, (am.get(r.artistKey) ?? 0) + r.c);
    dayArtists.set(dayIdx, am);
  }

  const WINDOW_DAYS = 90;
  const STEP_DAYS = 30;
  const MIN_WINDOW_PLAYS = 100;
  const MIN_SHARE = 0.25;

  const candidates: EraCandidate[] = [];
  for (let ws = minDay; ws <= maxDay; ws += STEP_DAYS) {
    const we = ws + WINDOW_DAYS; // exclusive
    let total = 0;
    const artistSum = new Map<string, number>();
    for (let d = ws; d < we; d++) {
      const t = dayTotals.get(d);
      if (!t) continue;
      total += t;
      const am = dayArtists.get(d)!;
      for (const [k, v] of am) artistSum.set(k, (artistSum.get(k) ?? 0) + v);
    }
    if (total < MIN_WINDOW_PLAYS) continue;
    // Dominant artist in this window.
    let bestKey = "";
    let bestPlays = 0;
    for (const [k, v] of artistSum) {
      if (v > bestPlays) {
        bestPlays = v;
        bestKey = k;
      }
    }
    const share = bestPlays / total;
    if (share >= MIN_SHARE) {
      candidates.push({
        artistKey: bestKey,
        startMs: ws * DAY_MS,
        endMs: we * DAY_MS,
        share,
        windowPlays: bestPlays,
      });
    }
  }
  if (candidates.length === 0) return [];

  // Merge overlapping/adjacent windows for the same artist into one era.
  const merged = new Map<string, EraCandidate[]>();
  for (const c of candidates) {
    const arr = merged.get(c.artistKey) ?? [];
    arr.push(c);
    merged.set(c.artistKey, arr);
  }
  const eras: EraCandidate[] = [];
  for (const arr of merged.values()) {
    arr.sort((a, b) => a.startMs - b.startMs);
    let cur = { ...arr[0] };
    for (let i = 1; i < arr.length; i++) {
      const nxt = arr[i];
      if (nxt.startMs <= cur.endMs) {
        // overlap → extend, keep the peak share
        cur.endMs = Math.max(cur.endMs, nxt.endMs);
        if (nxt.share > cur.share) {
          cur.share = nxt.share;
          cur.windowPlays = nxt.windowPlays;
        }
      } else {
        eras.push(cur);
        cur = { ...nxt };
      }
    }
    eras.push(cur);
  }

  // Top 3 distinct eras by share.
  const top = eras.sort((a, b) => b.share - a.share).slice(0, 3);

  const nameByKey = new Map(lcs.map((lc) => [lc.artistKey, lc.artistName]));
  const specs: PlaylistSpec[] = [];

  for (const era of top) {
    const start = new Date(era.startMs);
    const end = new Date(era.endMs);
    const mid = new Date((era.startMs + era.endMs) / 2);
    const artistName = nameByKey.get(era.artistKey) ?? era.artistKey;

    // That era's tracks by the dominant artist, most-played first.
    const trackRows = await db.$queryRaw<{ trackId: string; c: number }[]>`
      SELECT p."trackId" AS "trackId", COUNT(*)::int AS "c"
      FROM "Play" p JOIN "Track" t ON t.id = p."trackId"
      WHERE p."userId" = ${userId}
        AND COALESCE(t."artistId", t."artistName") = ${era.artistKey}
        AND p."playedAt" >= ${start} AND p."playedAt" < ${end}
      GROUP BY p."trackId"
      ORDER BY "c" DESC
      LIMIT ${MAX_ITEMS}
    `;
    if (trackRows.length === 0) continue;

    const oneIn = Math.max(2, Math.round(1 / era.share));
    const items = trackRows.map((r, i) => ({
      trackId: r.trackId,
      position: i,
      stat: `${plural(r.c, "play")} that era`,
    }));

    specs.push({
      kind: "ONE_ARTIST_ERA",
      title: `«${artistName}», ${seasonYear(mid)}`,
      description: `1 of every ${oneIn} songs you heard was them.`,
      meta: {
        artistId: era.artistKey,
        artistName,
        start: start.toISOString(),
        end: end.toISOString(),
        share: era.share,
      },
      items,
    });
  }

  return specs;
}

// ---------------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------------

/** 1-based day of year (UTC). */
function dayOfYear(d: Date): number {
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - start) / DAY_MS) + 1;
}

/** Count of timestamps within [lo, hi). */
function countInWindow(times: number[], lo: number, hi: number): number {
  let c = 0;
  for (const t of times) if (t >= lo && t < hi) c++;
  return c;
}

/** Max plays in any 28-day sliding window over ascending timestamps. */
function peakRate28d(times: number[]): number {
  const W = 28 * DAY_MS;
  let best = 0;
  let lo = 0;
  for (let hi = 0; hi < times.length; hi++) {
    while (times[hi] - times[lo] >= W) lo++;
    best = Math.max(best, hi - lo + 1);
  }
  return best;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Runs every generator and returns their specs. Pure computation — no writes.
 * Persisting is done by generateAllPlaylists in lib/playlists/index.ts.
 */
export async function buildPlaylistSpecs(userId: string, now: Date): Promise<PlaylistSpec[]> {
  const lcs = await loadLifecycles(userId);
  if (lcs.length === 0) return [];

  const coolingSet = new Set(lcs.filter((lc) => isCooling(lc, now)).map((lc) => lc.trackId));
  const last14 = await playCountsSince(userId, new Date(now.getTime() - 14 * DAY_MS));

  const [fullSend, oneNight, comeback, weekYear, wayOut, era] = await Promise.all([
    genFullSend(userId, coolingSet),
    genOneNightOnly(userId, lcs),
    genComebackKids(userId, lcs, now),
    genThisWeekEveryYear(userId, now),
    genOnTheWayOut(userId, now),
    genOneArtistEra(userId, lcs, now),
  ]);

  return [
    ...genTopAllTime(lcs, now),
    ...genHeavyRotation(lcs, last14, now),
    ...fullSend,
    ...oneNight,
    ...genGatewayDrugs(lcs),
    ...weekYear,
    ...comeback,
    ...genResurrection(lcs),
    ...genOneHitWonder(lcs),
    ...genNewBlood(lcs, now),
    ...wayOut,
    ...era,
  ];
}
