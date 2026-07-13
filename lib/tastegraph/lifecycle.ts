/**
 * Track lifecycle scoring (DESIGN §2 three clocks, §3 intensity×durability map,
 * §4 burnout/resurrection, §6.3 curve-shape signals).
 *
 * For each user+track we aggregate every play into:
 *   - three EventValue-weighted decay clocks (Pulse/Season/Core, halflives
 *     14/90/730d), with the §1 per-day loop cap (≤10 EventValue/day) applied and
 *     the ListenerProfile.completionMultiplier normalizing completion-derived
 *     positive value;
 *   - the intensity (Season percentile) × durability quadrant;
 *   - burnout (trailing-28d wearout ratio) + cooldown, resurrection eligibility;
 *   - curve shape, heartbeat regularity, honeymoon slope.
 *
 * The rows are fully derived, so each run deletes and recreates all of a user's
 * TrackLifecycle rows.
 *
 * Design deviations (documented, monotonic, defensible):
 *   - completionMultiplier is applied to the whole *positive* EventValue rather
 *     than only the Completion^0.7 factor — a simplification of "apply to
 *     completion-derived components".
 *   - Core floor = max(rawCore, 0.02 × Σ positive EventValue) per the task's
 *     "0.2 × (Σ positive eventValues) × 0.1" option.
 *   - `burned` sets a fresh 90-day cooldown every run (we delete/recreate, so
 *     there's no prior state to detect "newly burned").
 */

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { eventValue } from "@/lib/tastegraph/eventValue";
import { buildSessions, type PlayForSession } from "@/lib/tastegraph/sessionize";
import { computeListenerProfile } from "@/lib/tastegraph/calibration";

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const QUARTER_MS = 91.25 * DAY_MS;

export const HALF_LIFE_PULSE_DAYS = 14;
export const HALF_LIFE_SEASON_DAYS = 90;
export const HALF_LIFE_CORE_DAYS = 730;

/** Core-floor coefficient: max(rawCore, CORE_FLOOR_COEF × Σ positive EventValue). */
export const CORE_FLOOR_COEF = 0.02;

/** Per-day loop cap on positive EventValue (DESIGN §1 noise dampener). */
export const LOOP_CAP_PER_DAY = 10;

/** Burnout thresholds (DESIGN §4). */
export const BURN_RATIO = 0.15;
export const BURN_MIN_PLAYS = 12;
export const COOLDOWN_DAYS = 90;

/** Resurrection: dormant ≥180d and Core ≥ p70. */
export const RESURRECTION_DORMANT_DAYS = 180;
export const RESURRECTION_CORE_PCTL = 0.7;

/** Quadrant intensity threshold. */
export const HIGH_INTENSITY_PCTL = 0.7;

/** Minimum lifetime plays to qualify for the intensity/durability distributions. */
export const QUALIFY_MIN_PLAYS = 3;

/** Minimum plays required to emit each shape/rhythm signal. */
export const CURVE_MIN_PLAYS = 8;
export const HEARTBEAT_MIN_PLAYS = 5;

export type Quadrant = "ALL_TIMER" | "CURRENT_OBSESSION" | "SLEEPER" | "PHASE";
export type CurveShape = "COMET" | "STAR" | "SLEEPER_GROWER";

interface LcPlay {
  id: string;
  trackId: string;
  playedAtMs: number;
  msPlayed: number | null;
  durationMs: number | null;
  reasonStart: string | null;
  reasonEnd: string | null;
  shuffle: boolean | null;
  skipped: boolean | null;
  offline: boolean | null;
  album: string | null;
}

/** Per-track accumulator built in the first pass. */
interface TrackAgg {
  trackId: string;
  playedAtMs: number[]; // ascending
  evByPlay: number[]; // EventValue aligned with playedAtMs, multiplier applied
  msSum: bigint;
  firstMs: number;
  lastMs: number;
}

/** Intermediate per-track metrics, before cross-track ranking. */
interface TrackMetrics {
  trackId: string;
  firstPlayAt: Date;
  lastPlayAt: Date;
  lifetimePlays: number;
  lifetimeMs: bigint;
  pulseScore: number;
  seasonScore: number;
  coreScore: number;
  durability: number;
  curveShape: CurveShape | null;
  heartbeatCv: number | null;
  peakRate28d: number;
  currentRate28d: number;
  burned: boolean;
  honeymoonSlope: number | null;
}

/**
 * Computes and persists all TrackLifecycle rows for a user.
 *
 * `completionMultiplier` (ListenerProfile.completionMultiplier) normalizes
 * completion-derived value; pass it when the caller has already run calibration,
 * otherwise the profile is (re)computed here.
 */
export async function computeTrackLifecycles(
  userId: string,
  now: Date,
  completionMultiplier?: number
): Promise<number> {
  const multiplier =
    completionMultiplier ?? (await computeListenerProfile(userId)).completionMultiplier;
  const nowMs = now.getTime();

  const plays = await loadPlays(userId);
  if (plays.length === 0) {
    await db.trackLifecycle.deleteMany({ where: { userId } });
    return 0;
  }

  // Derive ephemeral session flags in memory (sessionId is persisted elsewhere).
  const forSession: PlayForSession[] = plays.map((p) => ({
    id: p.id,
    playedAt: new Date(p.playedAtMs),
    msPlayed: p.msPlayed,
    durationMs: p.durationMs,
    reasonStart: p.reasonStart,
    shuffle: p.shuffle,
    album: p.album,
  }));
  const sessioned = buildSessions(userId, forSession);
  const flagById = new Map(
    sessioned.map((s) => [s.id, { sessionStarter: s.sessionStarter, sequencedAlbum: s.sequencedAlbum }])
  );

  // First pass: EventValue per play (multiplier applied to positive value),
  // grouped per track.
  const byTrack = new Map<string, TrackAgg>();
  for (const p of plays) {
    const flags = flagById.get(p.id);
    let ev = eventValue({
      reasonStart: p.reasonStart,
      reasonEnd: p.reasonEnd,
      msPlayed: p.msPlayed,
      durationMs: p.durationMs,
      skipped: p.skipped,
      sessionStarter: flags?.sessionStarter ?? false,
      offline: p.offline ?? false,
      sequencedAlbum: flags?.sequencedAlbum ?? false,
    });
    // Normalize completion-driven positive value by the listener's multiplier.
    if (ev > 0) ev *= multiplier;

    let agg = byTrack.get(p.trackId);
    if (!agg) {
      agg = {
        trackId: p.trackId,
        playedAtMs: [],
        evByPlay: [],
        msSum: BigInt(0),
        firstMs: p.playedAtMs,
        lastMs: p.playedAtMs,
      };
      byTrack.set(p.trackId, agg);
    }
    agg.playedAtMs.push(p.playedAtMs);
    agg.evByPlay.push(ev);
    agg.msSum += BigInt(p.msPlayed ?? 0);
    if (p.playedAtMs < agg.firstMs) agg.firstMs = p.playedAtMs;
    if (p.playedAtMs > agg.lastMs) agg.lastMs = p.playedAtMs;
  }

  // Second pass: per-track metrics.
  const metrics: TrackMetrics[] = [];
  for (const agg of byTrack.values()) {
    metrics.push(computeTrackMetrics(agg, nowMs));
  }

  // Cross-track distributions for intensity percentile, durability median,
  // and the Core p70 resurrection gate.
  const qualifying = metrics.filter((m) => m.lifetimePlays >= QUALIFY_MIN_PLAYS);
  const seasonSorted = qualifying.map((m) => m.seasonScore).sort((a, b) => a - b);
  const durabilityMedian = median(qualifying.map((m) => m.durability));
  const coreP70 = percentileValue(
    metrics.map((m) => m.coreScore),
    RESURRECTION_CORE_PCTL
  );

  const dormantCutoffMs = nowMs - RESURRECTION_DORMANT_DAYS * DAY_MS;

  const rows: Prisma.TrackLifecycleCreateManyInput[] = metrics.map((m) => {
    const intensityPct = percentileRank(seasonSorted, m.seasonScore);
    const highIntensity = intensityPct >= HIGH_INTENSITY_PCTL;
    const highDurability = m.durability >= durabilityMedian;
    const quadrant = quadrantOf(highIntensity, highDurability);
    const resurrectionEligible =
      !m.burned &&
      m.coreScore >= coreP70 &&
      m.lastPlayAt.getTime() <= dormantCutoffMs;

    return {
      userId,
      trackId: m.trackId,
      firstPlayAt: m.firstPlayAt,
      lastPlayAt: m.lastPlayAt,
      lifetimePlays: m.lifetimePlays,
      lifetimeMs: m.lifetimeMs,
      pulseScore: m.pulseScore,
      seasonScore: m.seasonScore,
      coreScore: m.coreScore,
      intensityPct,
      durability: m.durability,
      quadrant,
      curveShape: m.curveShape,
      heartbeatCv: m.heartbeatCv,
      peakRate28d: m.peakRate28d,
      currentRate28d: m.currentRate28d,
      burned: m.burned,
      cooldownUntil: m.burned ? new Date(nowMs + COOLDOWN_DAYS * DAY_MS) : null,
      resurrectionEligible,
      honeymoonSlope: m.honeymoonSlope,
    };
  });

  // Fully derived: delete then recreate in chunks.
  await db.trackLifecycle.deleteMany({ where: { userId } });
  const CREATE_CHUNK = 1000;
  for (let i = 0; i < rows.length; i += CREATE_CHUNK) {
    await db.trackLifecycle.createMany({ data: rows.slice(i, i + CREATE_CHUNK) });
  }

  return rows.length;
}

/** Computes every per-track metric that doesn't need cross-track context. */
function computeTrackMetrics(agg: TrackAgg, nowMs: number): TrackMetrics {
  const times = agg.playedAtMs; // ascending (loader orders by playedAt)
  const evs = agg.evByPlay;
  const n = times.length;

  // --- three clocks with the per-day loop cap ---
  // Group play indices by UTC day, cap positive EventValue at 10/day.
  const dayPositive = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    if (evs[i] > 0) {
      const day = Math.floor(times[i] / DAY_MS);
      dayPositive.set(day, (dayPositive.get(day) ?? 0) + evs[i]);
    }
  }

  let pulse = 0;
  let season = 0;
  let coreRaw = 0;
  let sumPositive = 0;
  for (let i = 0; i < n; i++) {
    let ev = evs[i];
    if (ev > 0) {
      const day = Math.floor(times[i] / DAY_MS);
      const dayTotal = dayPositive.get(day) ?? ev;
      if (dayTotal > LOOP_CAP_PER_DAY) ev *= LOOP_CAP_PER_DAY / dayTotal;
    }
    const ageDays = Math.max(0, (nowMs - times[i]) / DAY_MS);
    pulse += ev * Math.pow(0.5, ageDays / HALF_LIFE_PULSE_DAYS);
    season += ev * Math.pow(0.5, ageDays / HALF_LIFE_SEASON_DAYS);
    coreRaw += ev * Math.pow(0.5, ageDays / HALF_LIFE_CORE_DAYS);
    if (ev > 0) sumPositive += ev;
  }
  const coreScore = Math.max(coreRaw, CORE_FLOOR_COEF * sumPositive);

  // --- durability ---
  const activeQuarters = new Set<string>();
  for (const t of times) {
    const d = new Date(t);
    activeQuarters.add(`${d.getUTCFullYear()}-${Math.floor(d.getUTCMonth() / 3)}`);
  }
  const quartersSinceFirst = Math.max(1, Math.floor((nowMs - agg.firstMs) / QUARTER_MS) + 1);
  const durability = (activeQuarters.size / quartersSinceFirst) * Math.log(1 + n);

  // --- burnout (weekly bins, sliding 28d window) ---
  const binCounts = new Map<number, number>();
  for (const t of times) {
    const bin = Math.floor((nowMs - t) / WEEK_MS); // 0 = most recent week
    if (bin >= 0) binCounts.set(bin, (binCounts.get(bin) ?? 0) + 1);
  }
  const maxBin = Math.max(0, Math.floor((nowMs - agg.firstMs) / WEEK_MS));
  const currentRate28d = binSum(binCounts, 0, 3);
  let peakRate28d = 0;
  for (let w = 0; w <= maxBin; w++) {
    peakRate28d = Math.max(peakRate28d, binSum(binCounts, w, w + 3));
  }
  const ratio = peakRate28d > 0 ? currentRate28d / peakRate28d : 0;
  const burned = ratio < BURN_RATIO && n >= BURN_MIN_PLAYS;

  return {
    trackId: agg.trackId,
    firstPlayAt: new Date(agg.firstMs),
    lastPlayAt: new Date(agg.lastMs),
    lifetimePlays: n,
    lifetimeMs: agg.msSum,
    pulseScore: pulse,
    seasonScore: season,
    coreScore,
    durability,
    curveShape: curveShapeOf(times, agg.firstMs, agg.lastMs, n),
    heartbeatCv: heartbeatCvOf(times),
    peakRate28d,
    currentRate28d,
    burned,
    honeymoonSlope: honeymoonSlopeOf(times, agg.firstMs),
  };
}

/** Sum of weekly-bin counts over the inclusive bin range [lo, hi]. */
function binSum(bins: Map<number, number>, lo: number, hi: number): number {
  let s = 0;
  for (let w = lo; w <= hi; w++) s += bins.get(w) ?? 0;
  return s;
}

/**
 * COMET (peak in first 20% of lifespan, then decline) / STAR (spread/flat) /
 * SLEEPER_GROWER (peak after 40% — chosen love). Null below CURVE_MIN_PLAYS.
 */
function curveShapeOf(
  times: number[],
  firstMs: number,
  lastMs: number,
  n: number
): CurveShape | null {
  if (n < CURVE_MIN_PLAYS) return null;
  const spanMs = lastMs - firstMs;
  if (spanMs <= 0) return "COMET"; // all plays in one instant/week — a burst

  const weeks = Math.floor(spanMs / WEEK_MS) + 1;
  const hist = new Array<number>(weeks).fill(0);
  for (const t of times) {
    const w = Math.min(weeks - 1, Math.floor((t - firstMs) / WEEK_MS));
    hist[w] += 1;
  }
  let peakWeek = 0;
  for (let w = 1; w < weeks; w++) if (hist[w] > hist[peakWeek]) peakWeek = w;
  const peakPos = weeks > 1 ? peakWeek / (weeks - 1) : 0;

  let massUpToPeak = 0;
  let massAfterPeak = 0;
  for (let w = 0; w < weeks; w++) {
    if (w <= peakWeek) massUpToPeak += hist[w];
    else massAfterPeak += hist[w];
  }

  if (peakPos <= 0.2 && massAfterPeak < massUpToPeak) return "COMET";
  if (peakPos >= 0.4) return "SLEEPER_GROWER";
  return "STAR";
}

/** Coefficient of variation of inter-play gaps (days). Null below the min. */
function heartbeatCvOf(times: number[]): number | null {
  if (times.length < HEARTBEAT_MIN_PLAYS) return null;
  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) gaps.push((times[i] - times[i - 1]) / DAY_MS);
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  if (mean <= 0) return null;
  const variance = gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length;
  return Math.sqrt(variance) / mean;
}

/**
 * Least-squares slope of per-day play counts over the first 21 days after the
 * first play (plays/day per day). Positive = accelerating honeymoon.
 */
function honeymoonSlopeOf(times: number[], firstMs: number): number | null {
  const WINDOW = 21;
  const counts = new Array<number>(WINDOW).fill(0);
  let any = false;
  for (const t of times) {
    const day = Math.floor((t - firstMs) / DAY_MS);
    if (day >= 0 && day < WINDOW) {
      counts[day] += 1;
      any = true;
    }
  }
  if (!any) return null;
  // slope of counts vs day index (x = 0..20).
  const nX = WINDOW;
  const sumX = (nX * (nX - 1)) / 2;
  const meanX = sumX / nX;
  const meanY = counts.reduce((a, b) => a + b, 0) / nX;
  let cov = 0;
  let varX = 0;
  for (let x = 0; x < nX; x++) {
    cov += (x - meanX) * (counts[x] - meanY);
    varX += (x - meanX) ** 2;
  }
  return varX > 0 ? cov / varX : 0;
}

function quadrantOf(highIntensity: boolean, highDurability: boolean): Quadrant {
  if (highIntensity) return highDurability ? "ALL_TIMER" : "CURRENT_OBSESSION";
  return highDurability ? "SLEEPER" : "PHASE";
}

/** Fraction of `sorted` (ascending) that is ≤ value. Empty → 0. */
function percentileRank(sorted: number[], value: number): number {
  if (sorted.length === 0) return 0;
  // upper bound: first index strictly greater than value
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo / sorted.length;
}

/** Value at the p-th percentile (0-1) of an unsorted array. */
function percentileValue(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

const LOAD_CHUNK = 10_000;

/** Streams a projection of every play for a user, ordered by playedAt ascending. */
async function loadPlays(userId: string): Promise<LcPlay[]> {
  const out: LcPlay[] = [];
  let cursorId: string | undefined;

  for (;;) {
    const page = await db.play.findMany({
      where: { userId },
      orderBy: [{ playedAt: "asc" }, { id: "asc" }],
      take: LOAD_CHUNK,
      ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
      select: {
        id: true,
        trackId: true,
        playedAt: true,
        msPlayed: true,
        reasonStart: true,
        reasonEnd: true,
        shuffle: true,
        skipped: true,
        offline: true,
        track: { select: { durationMs: true, albumName: true } },
      },
    });
    if (page.length === 0) break;

    for (const r of page) {
      out.push({
        id: r.id,
        trackId: r.trackId,
        playedAtMs: r.playedAt.getTime(),
        msPlayed: r.msPlayed,
        durationMs: r.track.durationMs,
        reasonStart: r.reasonStart,
        reasonEnd: r.reasonEnd,
        shuffle: r.shuffle,
        skipped: r.skipped,
        offline: r.offline,
        album: r.track.albumName,
      });
    }

    if (page.length < LOAD_CHUNK) break;
    cursorId = page[page.length - 1].id;
  }

  return out;
}
