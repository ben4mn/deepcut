/**
 * Deterministic synthetic Spotify "Extended Streaming History" export generator.
 *
 * Produces scripts/fixtures/demo_spotify_data.zip containing 2-3
 * Streaming_History_Audio_*.json files whose records match the exact shape
 * lib/import/parseExport.ts expects (see ExtendedRecord there), plus
 * scripts/fixtures/manifest.json mapping named behavioral patterns (see
 * docs/TASTEGRAPH-DESIGN.md §1-7) to the track/artist URIs that embody them,
 * so downstream tastegraph computation can be verified against real,
 * intentional signal instead of noise.
 *
 * Everything here is seeded (mulberry32 PRNG) so the same --seed always
 * produces byte-identical output.
 *
 * Usage:
 *   tsx scripts/generate-fixture.ts [--seed 42]
 */

import { mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";
import AdmZip from "adm-zip";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(): { seed: number } {
  const args = process.argv.slice(2);
  let seed = 42;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--seed" && args[i + 1] !== undefined) {
      seed = Number(args[i + 1]);
      i++;
    } else if (a.startsWith("--seed=")) {
      seed = Number(a.slice("--seed=".length));
    }
  }
  if (!Number.isFinite(seed)) seed = 42;
  return { seed };
}

const { seed: SEED } = parseArgs();

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32) + helpers
// ---------------------------------------------------------------------------

function mulberry32(seedValue: number): () => number {
  let a = seedValue >>> 0;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(SEED);

function randFloat(min: number, max: number): number {
  return min + rng() * (max - min);
}

function randInt(min: number, max: number): number {
  return Math.floor(randFloat(min, max + 1));
}

function chance(p: number): boolean {
  return rng() < p;
}

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

function weightedIndex(weights: readonly number[]): number {
  const total = weights.reduce((s, w) => s + w, 0);
  let r = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return weights.length - 1;
}

function shuffleInPlace<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Skewed-triangular integer, favoring `mode` between [min, max]. */
function triangularInt(min: number, max: number, mode: number): number {
  const u = rng();
  const c = (mode - min) / (max - min);
  let x: number;
  if (u < c) {
    x = min + Math.sqrt(u * (max - min) * (mode - min));
  } else {
    x = max - Math.sqrt((1 - u) * (max - min) * (max - mode));
  }
  return Math.round(Math.min(max, Math.max(min, x)));
}

const BASE62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
function genFakeId(len = 22): string {
  let out = "";
  for (let i = 0; i < len; i++) out += BASE62[Math.floor(rng() * BASE62.length)];
  return out;
}

// ---------------------------------------------------------------------------
// Time range: 3.5 years ending "now"
// ---------------------------------------------------------------------------

const NOW = new Date();
const RANGE_DAYS = Math.round(3.5 * 365);
const RANGE_START = new Date(
  Date.UTC(
    NOW.getUTCFullYear(),
    NOW.getUTCMonth(),
    NOW.getUTCDate() - RANGE_DAYS,
    0,
    0,
    0
  )
);

/** UTC date at `offsetDays` from RANGE_START, at the given time-of-day. */
function atDay(offsetDays: number, hour: number, minute = 0, second = 0): Date {
  return new Date(
    Date.UTC(
      RANGE_START.getUTCFullYear(),
      RANGE_START.getUTCMonth(),
      RANGE_START.getUTCDate() + offsetDays,
      hour,
      minute,
      second
    )
  );
}

function weekdayAt(offsetDays: number): number {
  return atDay(offsetDays, 12).getUTCDay(); // 0=Sun..6=Sat
}

// ---------------------------------------------------------------------------
// Catalog: ~120 artists / ~900 tracks
// ---------------------------------------------------------------------------

interface TrackDef {
  idx: number;
  artistIdx: number;
  artistName: string;
  trackName: string;
  albumName: string;
  albumTrackNo: number;
  durationSec: number;
  uri: string;
}

interface ArtistDef {
  idx: number;
  name: string;
  tracks: TrackDef[];
}

const NUM_ARTISTS = 120;
const artists: ArtistDef[] = [];
const allTracks: TrackDef[] = [];
let trackCursor = 0;

for (let a = 1; a <= NUM_ARTISTS; a++) {
  const artistName = `Artist ${a}`;
  const trackCount = randInt(3, 12);
  const artistTracks: TrackDef[] = [];

  // Group this artist's tracks into 1-3 albums, in order.
  const albumSizes: number[] = [];
  let remaining = trackCount;
  while (remaining > 0) {
    const size = Math.min(remaining, randInt(4, 8));
    albumSizes.push(size);
    remaining -= size;
  }

  let trackWithinArtist = 0;
  albumSizes.forEach((size, albumIdx) => {
    const albumName = `Artist ${a}: Album ${albumIdx + 1}`;
    for (let n = 1; n <= size; n++) {
      trackWithinArtist++;
      const isLong = chance(0.04);
      const durationSec = isLong ? randInt(420, 660) : randInt(120, 420);
      const track: TrackDef = {
        idx: trackCursor++,
        artistIdx: a,
        artistName,
        trackName: `Track ${a}-${trackWithinArtist}`,
        albumName,
        albumTrackNo: n,
        durationSec,
        uri: `spotify:track:${genFakeId()}`,
      };
      artistTracks.push(track);
      allTracks.push(track);
    }
  });

  artists.push({ idx: a, name: artistName, tracks: artistTracks });
}

// ---------------------------------------------------------------------------
// Role assignment (deterministic, order matters for reproducibility)
// ---------------------------------------------------------------------------

const usedArtistIdx = new Set<number>();
const usedTrackIdx = new Set<number>();

function pickUnusedArtists(n: number): ArtistDef[] {
  const candidates = shuffleInPlace(artists.filter((a) => !usedArtistIdx.has(a.idx)));
  const picked = candidates.slice(0, n);
  for (const a of picked) {
    usedArtistIdx.add(a.idx);
    for (const t of a.tracks) usedTrackIdx.add(t.idx);
  }
  return picked;
}

function pickUnusedTracks(n: number): TrackDef[] {
  const candidates = shuffleInPlace(allTracks.filter((t) => !usedTrackIdx.has(t.idx)));
  const picked = candidates.slice(0, n);
  for (const t of picked) usedTrackIdx.add(t.idx);
  return picked;
}

// Artist-level roles (reserve the whole artist's catalog).
const obsessionArtists = pickUnusedArtists(3);
const incognitoArtist = pickUnusedArtists(1)[0];
const resurrectionArtists = pickUnusedArtists(2);
const sequencedAlbumArtists = pickUnusedArtists(4);

// Track-level roles.
const canonTracks = pickUnusedTracks(30);
const cometTracks = pickUnusedTracks(10);
const sleeperTracks = pickUnusedTracks(10);
const weeklyRitualTracks = pickUnusedTracks(6);
const nightTracks = pickUnusedTracks(6);
const commuteTracks = pickUnusedTracks(8);
const conspicuousAvoidanceTracks = pickUnusedTracks(5);
const escapeVelocityTracks = pickUnusedTracks(2);
const burnedTracks = pickUnusedTracks(5);
const skipStormFodder = pickUnusedTracks(15);

const backbtnBeloved = shuffleInPlace([...canonTracks]).slice(0, 8);
const palateCleansers = shuffleInPlace([...canonTracks]).slice(0, 2);

// ---------------------------------------------------------------------------
// Record emission
// ---------------------------------------------------------------------------

interface RawRecord {
  ts: string;
  ms_played: number;
  spotify_track_uri: string;
  master_metadata_track_name: string;
  master_metadata_album_artist_name: string;
  master_metadata_album_album_name: string;
  reason_start: string;
  reason_end: string;
  shuffle: boolean;
  skipped: boolean;
  offline: boolean;
  incognito_mode: boolean;
  platform: string;
  conn_country: string;
}

const records: RawRecord[] = [];
const usedKeys = new Set<string>();

interface PushOpts {
  reasonStart: string;
  reasonEnd: string;
  completion: number;
  skipped: boolean;
  shuffle: boolean;
  offline: boolean;
  incognito: boolean;
  platform: string;
}

/** Pushes a play ending at `endDate`, nudging by +1s on timestamp collision. */
function push(track: TrackDef, endDate: Date, o: PushOpts): Date {
  let ts = endDate;
  let key = `${track.uri}|${ts.toISOString()}`;
  let attempts = 0;
  while (usedKeys.has(key) && attempts < 10) {
    ts = new Date(ts.getTime() + 1000);
    key = `${track.uri}|${ts.toISOString()}`;
    attempts++;
  }
  usedKeys.add(key);

  const completion = Math.min(1, Math.max(0, o.completion));
  const msPlayed = Math.round(track.durationSec * 1000 * completion);

  records.push({
    ts: ts.toISOString(),
    ms_played: msPlayed,
    spotify_track_uri: track.uri,
    master_metadata_track_name: track.trackName,
    master_metadata_album_artist_name: track.artistName,
    master_metadata_album_album_name: track.albumName,
    reason_start: o.reasonStart,
    reason_end: o.reasonEnd,
    shuffle: o.shuffle,
    skipped: o.skipped,
    offline: o.offline,
    incognito_mode: o.incognito,
    platform: o.platform,
    conn_country: "US",
  });

  return ts;
}

const PLATFORMS = ["ios", "osx", "web_player", "sonos"] as const;
const PLATFORM_WEIGHTS = [0.38, 0.27, 0.2, 0.15];
function pickPlatform(): string {
  return PLATFORMS[weightedIndex(PLATFORM_WEIGHTS)];
}

/** Normal, intentional, high-completion listen (used across many patterns). */
function lovedPlay(track: TrackDef, endDate: Date, opts: Partial<PushOpts> = {}): Date {
  return push(track, endDate, {
    reasonStart: opts.reasonStart ?? pick(["clickrow", "trackdone"]),
    reasonEnd: opts.reasonEnd ?? "trackdone",
    completion: opts.completion ?? randFloat(0.88, 1.0),
    skipped: opts.skipped ?? false,
    shuffle: opts.shuffle ?? false,
    offline: opts.offline ?? false,
    incognito: opts.incognito ?? false,
    platform: opts.platform ?? pickPlatform(),
  });
}

// ---------------------------------------------------------------------------
// Manifest (pattern -> URIs), populated as each pattern is generated
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const manifest: Record<string, unknown> = {};

// ---------------------------------------------------------------------------
// Pattern 1: obsession eras (3 artists, different 90-day windows/years)
// ---------------------------------------------------------------------------

/**
 * Must run LAST (after every other pattern + background filler has landed
 * its plays), so the 25-35% share is computed against the window's actual
 * total volume rather than a guess — this is what makes the guarantee exact
 * regardless of how dense background listening happens to be that quarter.
 */
function genObsessionEras(): void {
  const offsets = [0.14, 0.46, 0.78]; // spread across the range -> different years
  const entries: unknown[] = [];

  obsessionArtists.forEach((artist, i) => {
    const windowStartDay = Math.floor(RANGE_DAYS * offsets[i]);
    const windowLen = 90;
    const windowStartMs = atDay(windowStartDay, 0).getTime();
    const windowEndMs = atDay(windowStartDay + windowLen, 0).getTime();

    // Count everything already scheduled in this window (background + other
    // patterns) — the obsession artist itself has zero plays here so far,
    // since its whole catalog was reserved and excluded from every other
    // generator.
    let otherCount = 0;
    for (const r of records) {
      const t = Date.parse(r.ts);
      if (t >= windowStartMs && t < windowEndMs) otherCount++;
    }

    const targetRatio = randFloat(0.28, 0.32);
    let targetPlays = Math.round((otherCount * targetRatio) / (1 - targetRatio));
    targetPlays = Math.min(2200, Math.max(300, targetPlays));

    // A couple of "lead" tracks carry most of the plays, rest spread thinner.
    const weights = artist.tracks.map((_, ti) => (ti < 2 ? 4 : 1));

    for (let n = 0; n < targetPlays; n++) {
      const day = windowStartDay + randInt(0, windowLen - 1);
      const hour = randInt(7, 23);
      const track = artist.tracks[weightedIndex(weights)];
      lovedPlay(track, atDay(day, hour, randInt(0, 59), randInt(0, 59)), {
        completion: randFloat(0.82, 1.0),
        skipped: chance(0.05),
        reasonEnd: chance(0.05) ? "fwdbtn" : "trackdone",
      });
    }

    const actualShare = otherCount + targetPlays > 0 ? targetPlays / (otherCount + targetPlays) : 0;

    entries.push({
      artistUri: `deepcut:fake-artist:${artist.idx}`,
      artistName: artist.name,
      trackUris: artist.tracks.map((t) => t.uri),
      windowStart: atDay(windowStartDay, 0).toISOString(),
      windowEnd: atDay(windowStartDay + windowLen, 0).toISOString(),
      plays: targetPlays,
      windowTotalPlays: otherCount + targetPlays,
      shareOfWindow: actualShare,
    });
  });

  manifest.obsessionEras = entries;
}

// ---------------------------------------------------------------------------
// Pattern 2: stable canon (~30 tracks, steady every quarter)
// ---------------------------------------------------------------------------

function genCanon(): void {
  const quarterLen = 91;
  const numQuarters = Math.ceil(RANGE_DAYS / quarterLen);
  let totalPlays = 0;

  for (const track of canonTracks) {
    for (let q = 0; q < numQuarters; q++) {
      const qStart = q * quarterLen;
      const qEnd = Math.min(RANGE_DAYS - 1, qStart + quarterLen - 1);
      if (qStart > qEnd) continue;
      const playsThisQuarter = randInt(2, 4);
      for (let n = 0; n < playsThisQuarter; n++) {
        const day = randInt(qStart, qEnd);
        const hour = randInt(7, 23);
        lovedPlay(track, atDay(day, hour, randInt(0, 59), randInt(0, 59)), {
          completion: randFloat(0.9, 1.0),
          skipped: chance(0.04),
          reasonEnd: chance(0.04) ? "fwdbtn" : "trackdone",
        });
        totalPlays++;
      }
    }
  }

  manifest.stableCanon = {
    trackUris: canonTracks.map((t) => t.uri),
    quarters: numQuarters,
    totalPlays,
    note: "played every quarter across the full range, low skip, high completion",
  };
}

// ---------------------------------------------------------------------------
// Pattern 3: comets (burst 2 weeks then dead)
// ---------------------------------------------------------------------------

function genComets(): void {
  const entries: unknown[] = [];
  for (const track of cometTracks) {
    const burstStart = randInt(0, RANGE_DAYS - 30);
    const burstLen = 14;
    const plays = randInt(20, 45);
    for (let n = 0; n < plays; n++) {
      const day = burstStart + randInt(0, burstLen - 1);
      const hour = randInt(8, 23);
      lovedPlay(track, atDay(day, hour, randInt(0, 59), randInt(0, 59)), {
        completion: randFloat(0.8, 1.0),
      });
    }
    entries.push({
      trackUri: track.uri,
      burstStart: atDay(burstStart, 0).toISOString(),
      burstEnd: atDay(burstStart + burstLen, 0).toISOString(),
      plays,
      note: "no plays before or after the burst window",
    });
  }
  manifest.comets = entries;
}

// ---------------------------------------------------------------------------
// Pattern 4: sleepers/growers (sparse first 6mo, dense after)
// ---------------------------------------------------------------------------

function genSleepers(): void {
  const transitionDay = 180;
  const entries: unknown[] = [];
  for (const track of sleeperTracks) {
    const sparsePlays = randInt(3, 8);
    for (let n = 0; n < sparsePlays; n++) {
      const day = randInt(0, transitionDay - 1);
      lovedPlay(track, atDay(day, randInt(9, 23), randInt(0, 59)), {
        completion: randFloat(0.6, 0.95),
      });
    }
    const densePlays = randInt(60, 110);
    for (let n = 0; n < densePlays; n++) {
      const day = randInt(transitionDay, RANGE_DAYS - 1);
      lovedPlay(track, atDay(day, randInt(7, 23), randInt(0, 59)), {
        completion: randFloat(0.75, 1.0),
      });
    }
    entries.push({
      trackUri: track.uri,
      transitionDay: atDay(transitionDay, 0).toISOString(),
      sparsePlays,
      densePlays,
    });
  }
  manifest.sleepersGrowers = entries;
}

// ---------------------------------------------------------------------------
// Pattern 5: weekly-ritual tracks (every ~7d, low variance)
// ---------------------------------------------------------------------------

function genWeeklyRitual(): void {
  const entries: unknown[] = [];
  for (const track of weeklyRitualTracks) {
    const weekday = randInt(0, 6);
    const hour = randInt(6, 22);
    let day = randInt(0, 6);
    // Align to the chosen weekday near the start of the range.
    while (weekdayAt(day) !== weekday && day < 7) day++;
    let occurrences = 0;
    while (day < RANGE_DAYS) {
      lovedPlay(track, atDay(day, hour, randInt(0, 20)), {
        completion: randFloat(0.9, 1.0),
      });
      occurrences++;
      day += 7 + randInt(-1, 1);
    }
    entries.push({ trackUri: track.uri, weekday, hour, occurrences, note: "~7d cadence, low variance" });
  }
  manifest.weeklyRitual = entries;
}

// ---------------------------------------------------------------------------
// Pattern 6: night tracks (clustered 1-4am)
// ---------------------------------------------------------------------------

function genNightTracks(): void {
  const entries: unknown[] = [];
  for (const track of nightTracks) {
    const plays = randInt(80, 150);
    for (let n = 0; n < plays; n++) {
      const day = randInt(0, RANGE_DAYS - 1);
      const hour = randInt(1, 4);
      lovedPlay(track, atDay(day, hour, randInt(0, 59), randInt(0, 59)), {
        completion: randFloat(0.6, 1.0),
      });
    }
    entries.push({ trackUri: track.uri, plays, hourRange: "1-4am" });
  }
  manifest.nightTracks = entries;
}

// ---------------------------------------------------------------------------
// Pattern 7: morning-commute cluster (weekday 7-9am, ios, offline)
// ---------------------------------------------------------------------------

function genCommute(): void {
  let sessions = 0;
  for (let day = 0; day < RANGE_DAYS; day++) {
    const wd = weekdayAt(day);
    if (wd === 0 || wd === 6) continue; // weekends
    if (!chance(0.65)) continue;

    const hour = randInt(7, 8);
    let cursor = atDay(day, hour, randInt(0, 59));
    const sessionLen = randInt(1, 3);
    for (let n = 0; n < sessionLen; n++) {
      const track = pick(commuteTracks);
      cursor = push(track, cursor, {
        reasonStart: n === 0 ? "clickrow" : "trackdone",
        reasonEnd: "trackdone",
        completion: randFloat(0.85, 1.0),
        skipped: false,
        shuffle: false,
        offline: true,
        incognito: false,
        platform: "ios",
      });
      cursor = new Date(cursor.getTime() + randInt(2, 20) * 1000);
    }
    sessions++;
  }
  manifest.morningCommute = {
    trackUris: commuteTracks.map((t) => t.uri),
    window: "weekday 7-9am",
    platform: "ios",
    offline: true,
    sessions,
  };
}

// ---------------------------------------------------------------------------
// Pattern 8: skip storms (3-6 early fwdbtn skips) -> palate cleanser
// ---------------------------------------------------------------------------

function genSkipStorms(): void {
  let storms = 0;
  let day = randInt(0, 9);
  while (day < RANGE_DAYS) {
    const hour = randInt(8, 22);
    let cursor = atDay(day, hour, randInt(0, 59));
    const runLen = randInt(3, 6);
    for (let n = 0; n < runLen; n++) {
      const track = pick(skipStormFodder);
      cursor = push(track, cursor, {
        reasonStart: "trackdone",
        reasonEnd: "fwdbtn",
        completion: randFloat(0.02, 0.2),
        skipped: true,
        shuffle: false,
        offline: false,
        incognito: false,
        platform: pickPlatform(),
      });
      cursor = new Date(cursor.getTime() + randInt(3, 15) * 1000);
    }
    // The trusted reset: a fully completed palate cleanser right after.
    const cleanser = pick(palateCleansers);
    push(cleanser, cursor, {
      reasonStart: "trackdone",
      reasonEnd: "trackdone",
      completion: randFloat(0.95, 1.0),
      skipped: false,
      shuffle: false,
      offline: false,
      incognito: false,
      platform: pickPlatform(),
    });
    storms++;
    day += randInt(7, 14);
  }
  manifest.skipStorms = {
    fodderTrackUris: skipStormFodder.map((t) => t.uri),
    palateCleanserTrackUris: palateCleansers.map((t) => t.uri),
    storms,
  };
}

// ---------------------------------------------------------------------------
// Pattern 9: conspicuous avoidance (always-skipped-early, served via trackdone)
// ---------------------------------------------------------------------------

function genConspicuousAvoidance(): void {
  const entries: unknown[] = [];
  for (const track of conspicuousAvoidanceTracks) {
    const serves = randInt(15, 30);
    for (let n = 0; n < serves; n++) {
      const day = randInt(0, RANGE_DAYS - 1);
      const hour = randInt(6, 23);
      const capMs = Math.min(59000, Math.floor(track.durationSec * 1000 * 0.24));
      const completion = capMs / (track.durationSec * 1000);
      push(track, atDay(day, hour, randInt(0, 59)), {
        reasonStart: "trackdone",
        reasonEnd: "fwdbtn",
        completion: Math.max(0.01, completion * randFloat(0.4, 1.0)),
        skipped: true,
        shuffle: false,
        offline: false,
        incognito: false,
        platform: pickPlatform(),
      });
    }
    entries.push({ trackUri: track.uri, serves, note: "always skipped early despite repeated autoplay serves" });
  }
  manifest.conspicuousAvoidance = entries;
}

// ---------------------------------------------------------------------------
// Pattern 10: escape velocity (reached via fwdbtn, then completed)
// ---------------------------------------------------------------------------

function genEscapeVelocity(): void {
  const entries: unknown[] = [];
  for (const track of escapeVelocityTracks) {
    const plays = randInt(15, 25);
    for (let n = 0; n < plays; n++) {
      const day = randInt(0, RANGE_DAYS - 1);
      const hour = randInt(7, 23);
      push(track, atDay(day, hour, randInt(0, 59)), {
        reasonStart: "fwdbtn",
        reasonEnd: "trackdone",
        completion: randFloat(0.9, 1.0),
        skipped: false,
        shuffle: false,
        offline: false,
        incognito: false,
        platform: pickPlatform(),
      });
    }
    entries.push({ trackUri: track.uri, plays, note: "arrived at by skipping forward, then completed far above baseline" });
  }
  manifest.escapeVelocity = entries;
}

// ---------------------------------------------------------------------------
// Pattern 11: incognito cluster (one artist, ~80% incognito early -> public later)
// ---------------------------------------------------------------------------

function genIncognitoCluster(): void {
  const activeEnd = Math.floor(RANGE_DAYS * 0.9);
  const splitDay = Math.floor(activeEnd / 2);
  const totalPlays = randInt(70, 110);
  let earlyIncognito = 0;
  let lateIncognito = 0;
  let earlyTotal = 0;
  let lateTotal = 0;

  for (let n = 0; n < totalPlays; n++) {
    const day = randInt(0, activeEnd);
    const track = pick(incognitoArtist.tracks);
    const isEarly = day < splitDay;
    const incognito = isEarly ? chance(0.8) : chance(0.2);
    if (isEarly) {
      earlyTotal++;
      if (incognito) earlyIncognito++;
    } else {
      lateTotal++;
      if (incognito) lateIncognito++;
    }
    lovedPlay(track, atDay(day, randInt(9, 23), randInt(0, 59)), {
      completion: randFloat(0.7, 1.0),
      incognito,
    });
  }

  manifest.incognitoCluster = {
    artistUri: `deepcut:fake-artist:${incognitoArtist.idx}`,
    artistName: incognitoArtist.name,
    trackUris: incognitoArtist.tracks.map((t) => t.uri),
    splitDate: atDay(splitDay, 0).toISOString(),
    earlyIncognitoRate: earlyTotal ? earlyIncognito / earlyTotal : 0,
    lateIncognitoRate: lateTotal ? lateIncognito / lateTotal : 0,
    totalPlays,
    note: "you stopped hiding this",
  };
}

// ---------------------------------------------------------------------------
// Pattern 12: sequenced album sessions (shuffle=false, full album in order)
// ---------------------------------------------------------------------------

function genSequencedAlbumSessions(): void {
  const entries: unknown[] = [];
  for (const artist of sequencedAlbumArtists) {
    // Use the artist's first album (contiguous tracks with albumTrackNo 1..N).
    const albumName = artist.tracks[0].albumName;
    const albumTracks = artist.tracks
      .filter((t) => t.albumName === albumName)
      .sort((a, b) => a.albumTrackNo - b.albumTrackNo);

    let sessions = 0;
    let day = randInt(0, 30);
    while (day < RANGE_DAYS) {
      const hour = randInt(9, 22);
      let cursor = atDay(day, hour, randInt(0, 59));
      albumTracks.forEach((track, i) => {
        cursor = push(track, cursor, {
          reasonStart: i === 0 ? "clickrow" : "trackdone",
          reasonEnd: "trackdone",
          completion: randFloat(0.92, 1.0),
          skipped: false,
          shuffle: false,
          offline: chance(0.15),
          incognito: false,
          platform: pickPlatform(),
        });
        cursor = new Date(cursor.getTime() + randInt(3, 12) * 1000);
      });
      sessions++;
      day += randInt(75, 110);
    }

    entries.push({
      albumName,
      artistUri: `deepcut:fake-artist:${artist.idx}`,
      trackUris: albumTracks.map((t) => t.uri),
      sessions,
    });
  }
  manifest.sequencedAlbumSessions = entries;
}

// ---------------------------------------------------------------------------
// Pattern 13: immediate backbtn replays on beloved tracks
// ---------------------------------------------------------------------------

function genBackbtnReplays(): void {
  let replayEvents = 0;
  for (const track of backbtnBeloved) {
    const events = randInt(8, 15);
    for (let n = 0; n < events; n++) {
      const day = randInt(0, RANGE_DAYS - 1);
      const hour = randInt(7, 23);
      const firstEnd = lovedPlay(track, atDay(day, hour, randInt(0, 59)), {
        completion: randFloat(0.85, 1.0),
      });
      const secondStart = new Date(firstEnd.getTime() + randInt(1, 5) * 1000);
      push(track, secondStart, {
        reasonStart: "backbtn",
        reasonEnd: "trackdone",
        completion: randFloat(0.7, 1.0),
        skipped: false,
        shuffle: false,
        offline: false,
        incognito: false,
        platform: pickPlatform(),
      });
      replayEvents++;
    }
  }
  manifest.backbtnBeloved = {
    trackUris: backbtnBeloved.map((t) => t.uri),
    replayEvents,
    note: "immediate replay via backbtn right after finishing",
  };
}

// ---------------------------------------------------------------------------
// Pattern 14: resurrection artists (heavy -> silent -> back)
// ---------------------------------------------------------------------------

function genResurrectionArtists(): void {
  const entries: unknown[] = [];
  const heavy1End = Math.floor(RANGE_DAYS * 0.22);
  const silentEnd = Math.floor(RANGE_DAYS * 0.55);

  for (const artist of resurrectionArtists) {
    const heavy1Plays = randInt(150, 250);
    for (let n = 0; n < heavy1Plays; n++) {
      const day = randInt(0, heavy1End - 1);
      lovedPlay(pick(artist.tracks), atDay(day, randInt(7, 23), randInt(0, 59)), {
        completion: randFloat(0.8, 1.0),
      });
    }
    const heavy2Plays = randInt(180, 300);
    for (let n = 0; n < heavy2Plays; n++) {
      const day = randInt(silentEnd, RANGE_DAYS - 1);
      lovedPlay(pick(artist.tracks), atDay(day, randInt(7, 23), randInt(0, 59)), {
        completion: randFloat(0.8, 1.0),
      });
    }
    entries.push({
      artistUri: `deepcut:fake-artist:${artist.idx}`,
      artistName: artist.name,
      trackUris: artist.tracks.map((t) => t.uri),
      heavyPeriod1: { start: atDay(0, 0).toISOString(), end: atDay(heavy1End, 0).toISOString(), plays: heavy1Plays },
      silentPeriod: { start: atDay(heavy1End, 0).toISOString(), end: atDay(silentEnd, 0).toISOString() },
      heavyPeriod2: { start: atDay(silentEnd, 0).toISOString(), end: atDay(RANGE_DAYS, 0).toISOString(), plays: heavy2Plays },
    });
  }
  manifest.resurrectionArtists = entries;
}

// ---------------------------------------------------------------------------
// Pattern 15: burned track (heavy 3mo, >=12 plays, then <15% of peak rate)
// ---------------------------------------------------------------------------

function genBurnedTracks(): void {
  const entries: unknown[] = [];
  for (const track of burnedTracks) {
    const peakStart = randInt(0, RANGE_DAYS - 270);
    const peakLen = 90;
    const peakEnd = peakStart + peakLen;
    const peakPlays = randInt(35, 60); // well above the >=12 floor
    for (let n = 0; n < peakPlays; n++) {
      const day = peakStart + randInt(0, peakLen - 1);
      lovedPlay(track, atDay(day, randInt(7, 23), randInt(0, 59)), {
        completion: randFloat(0.85, 1.0),
      });
    }
    const peakRatePerDay = peakPlays / peakLen;

    const tailDays = RANGE_DAYS - peakEnd;
    const tailPlays = Math.max(2, Math.floor(peakRatePerDay * tailDays * 0.1)); // ~10% of peak rate, safely <15%
    for (let n = 0; n < tailPlays; n++) {
      const day = peakEnd + randInt(0, Math.max(0, tailDays - 1));
      lovedPlay(track, atDay(day, randInt(7, 23), randInt(0, 59)), {
        completion: randFloat(0.6, 1.0),
      });
    }
    const tailRatePerDay = tailDays > 0 ? tailPlays / tailDays : 0;

    entries.push({
      trackUri: track.uri,
      peakWindow: { start: atDay(peakStart, 0).toISOString(), end: atDay(peakEnd, 0).toISOString(), plays: peakPlays, ratePerDay: peakRatePerDay },
      tailPlays,
      tailRatePerDay,
      ratioOfPeak: peakRatePerDay > 0 ? tailRatePerDay / peakRatePerDay : 0,
    });
  }
  manifest.burnedTracks = entries;
}

// ---------------------------------------------------------------------------
// Background filler: ordinary listening, session-shaped, fills to target total
// ---------------------------------------------------------------------------

const HOUR_WEIGHTS = [
  2, 1, 1, 1, 1, 1, 2, 4, 5, 4, 3, 3, 4, 4, 4, 4, 5, 6, 7, 8, 8, 7, 5, 3,
];
function pickHour(): number {
  return weightedIndex(HOUR_WEIGHTS);
}

const backgroundPool = allTracks.filter((t) => !usedTrackIdx.has(t.idx));
const artistOrder = shuffleInPlace(artists.map((a) => a.idx));
const artistWeight = new Map<number, number>();
artistOrder.forEach((artistIdx, rank) => artistWeight.set(artistIdx, 1 / Math.pow(rank + 1, 0.75)));
const backgroundWeights = backgroundPool.map((t) => artistWeight.get(t.artistIdx) ?? 0.01);

function pickBackgroundTrack(): TrackDef {
  return backgroundPool[weightedIndex(backgroundWeights)];
}

function genBackgroundPlay(cursor: Date, sessionShuffle: boolean, sessionOffline: boolean, sessionPlatform: string, isFirst: boolean): { end: Date } {
  const track = pickBackgroundTrack();
  const endRoll = rng();
  let reasonEnd: string;
  let completion: number;
  let skipped: boolean;
  if (endRoll < 0.12) {
    reasonEnd = "fwdbtn";
    completion = randFloat(0.03, 0.24);
    skipped = true;
  } else if (endRoll < 0.2) {
    reasonEnd = "fwdbtn";
    completion = randFloat(0.25, 0.79);
    skipped = true;
  } else if (endRoll < 0.25) {
    reasonEnd = "fwdbtn";
    completion = randFloat(0.8, 0.99);
    skipped = true;
  } else if (endRoll < 0.28) {
    reasonEnd = "endplay";
    completion = randFloat(0.3, 0.95);
    skipped = false;
  } else {
    reasonEnd = "trackdone";
    completion = randFloat(0.85, 1.0);
    skipped = false;
  }

  const reasonStart = isFirst
    ? pick(["clickrow", "appload", "remote"])
    : pick(["trackdone", "trackdone", "trackdone", "clickrow", "backbtn", "remote"]);

  const end = push(track, cursor, {
    reasonStart,
    reasonEnd,
    completion,
    skipped,
    shuffle: sessionShuffle,
    offline: sessionOffline,
    incognito: chance(0.03),
    platform: sessionPlatform,
  });
  return { end };
}

function genBackground(targetCount: number): void {
  const avgDaily = targetCount / RANGE_DAYS;
  let remaining = targetCount;

  for (let day = 0; day < RANGE_DAYS && remaining > 0; day++) {
    let dayBudget = Math.max(0, Math.round(avgDaily * (0.6 + rng() * 0.8)));
    dayBudget = Math.min(dayBudget, remaining, 200);
    let used = 0;
    let lastEnd: Date | null = null;
    let guard = 0;

    while (used < dayBudget && guard < 20) {
      guard++;
      const sessionLen = Math.min(dayBudget - used, triangularInt(3, 40, 10));
      const sessionShuffle = chance(0.5);
      const sessionOffline = chance(0.1);
      const sessionPlatform = pickPlatform();

      let startCursor = atDay(day, pickHour(), randInt(0, 59), randInt(0, 59));
      if (lastEnd && startCursor.getTime() - lastEnd.getTime() < 30 * 60 * 1000) {
        startCursor = new Date(lastEnd.getTime() + randInt(30, 600) * 60 * 1000);
      }

      let cursor = startCursor;
      for (let k = 0; k < sessionLen; k++) {
        const { end } = genBackgroundPlay(cursor, sessionShuffle, sessionOffline, sessionPlatform, k === 0);
        cursor = new Date(end.getTime() + randInt(2, 240) * 1000);
      }
      lastEnd = cursor;
      used += sessionLen;
    }
    remaining -= used;
  }

  // Top up any shortfall from the guard cap with scattered single plays.
  let topUpGuard = 0;
  while (remaining > 0 && topUpGuard < targetCount * 2) {
    topUpGuard++;
    const day = randInt(0, RANGE_DAYS - 1);
    genBackgroundPlay(atDay(day, pickHour(), randInt(0, 59)), chance(0.5), chance(0.1), pickPlatform(), true);
    remaining--;
  }
}

// ---------------------------------------------------------------------------
// Run generation
// ---------------------------------------------------------------------------

genCanon();
genComets();
genSleepers();
genWeeklyRitual();
genNightTracks();
genCommute();
genSkipStorms();
genConspicuousAvoidance();
genEscapeVelocity();
genIncognitoCluster();
genSequencedAlbumSessions();
genBackbtnReplays();
genResurrectionArtists();
genBurnedTracks();

const forcedCountPreObsession = records.length;

// Obsession eras are sized reactively (see genObsessionEras) against whatever
// background + other-pattern volume lands in their windows, so background
// must be generated first. Reserve headroom for the ~3 eras here so the
// final total (background + other-forced + obsession) still lands in
// [MIN_TOTAL, MAX_TOTAL].
const OBSESSION_RESERVE = 2700;
const TARGET_TOTAL = 42000;
const MIN_TOTAL = 35000;
const MAX_TOTAL = 50000;
const effectiveTarget = TARGET_TOTAL - OBSESSION_RESERVE;
const effectiveMin = MIN_TOTAL - OBSESSION_RESERVE;
const effectiveMax = MAX_TOTAL - OBSESSION_RESERVE;
let backgroundTarget = effectiveTarget - forcedCountPreObsession;
if (forcedCountPreObsession + backgroundTarget < effectiveMin) {
  backgroundTarget = effectiveMin - forcedCountPreObsession;
}
if (forcedCountPreObsession + backgroundTarget > effectiveMax) {
  backgroundTarget = effectiveMax - forcedCountPreObsession;
}
backgroundTarget = Math.max(0, backgroundTarget);

genBackground(backgroundTarget);

const backgroundActual = records.length - forcedCountPreObsession;

genObsessionEras();

const forcedCount = records.length - backgroundActual;

records.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

// ---------------------------------------------------------------------------
// Write ZIP (2-3 Streaming_History_Audio_*.json files) + manifest.json
// ---------------------------------------------------------------------------

const fixturesDir = resolve(process.cwd(), "scripts/fixtures");
mkdirSync(fixturesDir, { recursive: true });

const numFiles = records.length > 30000 ? 3 : 2;
const chunkSize = Math.ceil(records.length / numFiles);
const zip = new AdmZip();
const usedLabels = new Map<string, number>();

for (let i = 0; i < numFiles; i++) {
  const chunk = records.slice(i * chunkSize, (i + 1) * chunkSize);
  if (chunk.length === 0) continue;
  const minYear = chunk[0].ts.slice(0, 4);
  const maxYear = chunk[chunk.length - 1].ts.slice(0, 4);
  const label = minYear === maxYear ? minYear : `${minYear}-${maxYear}`;
  const suffix = usedLabels.get(label) ?? 0;
  usedLabels.set(label, suffix + 1);
  const filename = `Streaming_History_Audio_${label}_${suffix}.json`;
  zip.addFile(filename, Buffer.from(JSON.stringify(chunk), "utf8"));
}

const zipPath = resolve(fixturesDir, "demo_spotify_data.zip");
zip.writeZip(zipPath);

writeFileSync(
  resolve(fixturesDir, "manifest.json"),
  JSON.stringify(
    {
      seed: SEED,
      generatedAt: new Date().toISOString(),
      rangeStart: RANGE_START.toISOString(),
      rangeEnd: NOW.toISOString(),
      totalRecords: records.length,
      forcedPatternRecords: forcedCount,
      backgroundRecords: records.length - forcedCount,
      patterns: manifest,
    },
    null,
    2
  )
);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const byYear = new Map<string, number>();
const byArtist = new Map<string, number>();
for (const r of records) {
  const year = r.ts.slice(0, 4);
  byYear.set(year, (byYear.get(year) ?? 0) + 1);
  byArtist.set(
    r.master_metadata_album_artist_name,
    (byArtist.get(r.master_metadata_album_artist_name) ?? 0) + 1
  );
}

console.log(`\ndeepcut synthetic fixture generated (seed=${SEED})`);
console.log(`  zip:      ${zipPath}`);
console.log(`  manifest: ${resolve(fixturesDir, "manifest.json")}`);
console.log(`  range:    ${RANGE_START.toISOString()} -> ${NOW.toISOString()} (${RANGE_DAYS} days)`);
console.log(`  files:    ${numFiles}`);
console.log(`  total records: ${records.length} (forced=${forcedCount}, background=${records.length - forcedCount})`);

console.log("\nrecords by year:");
for (const [year, count] of [...byYear.entries()].sort()) {
  console.log(`  ${year}: ${count}`);
}

console.log("\ntop 15 artists by play count:");
for (const [name, count] of [...byArtist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  console.log(`  ${name}: ${count}`);
}

console.log("\npattern manifest (see manifest.json for full URI lists):");
for (const key of Object.keys(manifest)) {
  console.log(`  - ${key}`);
}
console.log("");
