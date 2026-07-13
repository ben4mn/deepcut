/**
 * The event value model (DESIGN §1).
 *
 * Every play event earns a value from *how it started*, *how it ended*, and
 * *how much was heard* — not just that it happened:
 *
 *   EventValue = StartWeight × EndFactor × Completion^0.7 × (1 + Σ ContextBonuses)
 *
 * A play you sought out and finished is worth ~3× a passive autoplay; an early
 * skip is actively negative. This module is a pure function over a single play —
 * no database, no cross-play state — so it's trivially unit-testable and the
 * weights live in exported constants for tuning.
 *
 * NOTE: the §1 noise dampeners that need cross-play context — the per-day loop
 * cap (10 EventValue/day) and wallpaper detection (long uninterrupted trackdone
 * chains) — are NOT applied here. The loop cap is applied at aggregation time in
 * lib/tastegraph/lifecycle.ts; wallpaper detection is deferred.
 */

/** Start weights by reason_start (intentionality). */
export const START_WEIGHTS = {
  /** immediate replay — strongest single signal in the dataset */
  backbtn: 2.0,
  /** deliberate choice */
  clickrow: 1.5,
  search: 1.5,
  playbtn: 1.5,
  /** passive autoplay chain — baseline */
  trackdone: 1.0,
} as const;

/** Ambient/incidental starts (appload/remote/unknown/null) fall through to this. */
export const START_WEIGHT_DEFAULT = 0.9;

/** End factors that don't depend on play position. */
export const END_FACTORS = {
  /** consumed */
  trackdone: 1.0,
  /** session ended, not a judgment */
  endplay: 0.9,
  logout: 0.9,
} as const;

/** Baseline end factor for any other (non-fwdbtn, non-unexpected) reason_end. */
export const END_FACTOR_DEFAULT = 0.9;

/** fwdbtn position tiers (DESIGN §1 "End factors"). */
export const FWD_CONSUMED = 0.8; // >80% heard — effectively consumed, mild impatience
export const FWD_LUKEWARM = 0.1; // 25–80% heard
export const FWD_REJECTION = -0.8; // <25% heard AND <60s — active rejection
/** fwdbtn when completion is unknown (POLL rows): non-negative neutral fallback. */
export const FWD_UNKNOWN = 0.5;

/** unexpected-exit → discard: the whole event is worth zero (not a signal). */
export const UNEXPECTED_EXIT_FACTOR = 0.0;

/** Completion factor used when ms_played or duration is unavailable (POLL rows). */
export const COMPLETION_UNKNOWN = 0.85;

/** Exponent applied to raw completion so partial listens aren't linearly cheap. */
export const COMPLETION_EXPONENT = 0.7;

/** Early-skip thresholds for the fwdbtn rejection tier. */
export const EARLY_SKIP_PCT = 0.25;
export const EARLY_SKIP_MS = 60_000;

/** Context bonuses (additive, then applied as a (1 + Σ) multiplier). */
export const CONTEXT_BONUS = {
  sessionStarter: 0.25,
  offline: 0.15,
  sequencedAlbum: 0.1,
} as const;

export interface EventValueInput {
  reasonStart: string | null | undefined;
  reasonEnd: string | null | undefined;
  msPlayed: number | null | undefined;
  durationMs: number | null | undefined;
  skipped: boolean | null | undefined;
  /** first intentional play of a session after a ≥30-min gap */
  sessionStarter: boolean;
  /** committed storage to it */
  offline: boolean;
  /** shuffle=false, part of a ≥3 in-order same-album run */
  sequencedAlbum: boolean;
}

/** Raw completion in [0,1], or null when ms_played/duration is unavailable. */
function rawCompletion(
  msPlayed: number | null | undefined,
  durationMs: number | null | undefined
): number | null {
  if (
    msPlayed === null ||
    msPlayed === undefined ||
    durationMs === null ||
    durationMs === undefined ||
    durationMs <= 0
  ) {
    return null;
  }
  return Math.min(msPlayed / durationMs, 1);
}

/** StartWeight from reason_start. */
export function startWeight(reasonStart: string | null | undefined): number {
  if (reasonStart && reasonStart in START_WEIGHTS) {
    return START_WEIGHTS[reasonStart as keyof typeof START_WEIGHTS];
  }
  return START_WEIGHT_DEFAULT;
}

/**
 * EndFactor from reason_end and how much was heard.
 *
 * When completion is unknown (POLL rows) we can't detect an early skip, so the
 * negative fwdbtn tier is never reached — fwdbtn falls back to FWD_UNKNOWN and
 * an unknown reason_end with skipped=true is treated as a lukewarm skip.
 */
export function endFactor(
  reasonEnd: string | null | undefined,
  completion: number | null,
  msPlayed: number | null | undefined,
  skipped: boolean | null | undefined
): number {
  if (reasonEnd && /unexpected/i.test(reasonEnd)) {
    return UNEXPECTED_EXIT_FACTOR;
  }
  if (reasonEnd === "trackdone") return END_FACTORS.trackdone;
  if (reasonEnd === "endplay" || reasonEnd === "logout") return END_FACTORS.endplay;

  if (reasonEnd === "fwdbtn") {
    if (completion === null) return FWD_UNKNOWN;
    if (completion > 0.8) return FWD_CONSUMED;
    if (
      completion < EARLY_SKIP_PCT &&
      msPlayed !== null &&
      msPlayed !== undefined &&
      msPlayed < EARLY_SKIP_MS
    ) {
      return FWD_REJECTION;
    }
    return FWD_LUKEWARM;
  }

  // No informative reason_end. If the row is flagged as an early skip and we can
  // confirm it from position, treat it like a rejection; otherwise baseline.
  if (
    skipped === true &&
    completion !== null &&
    completion < EARLY_SKIP_PCT &&
    msPlayed !== null &&
    msPlayed !== undefined &&
    msPlayed < EARLY_SKIP_MS
  ) {
    return FWD_REJECTION;
  }
  return END_FACTOR_DEFAULT;
}

/** Completion^0.7, or the POLL default when completion is unknown. */
export function completionFactor(completion: number | null): number {
  if (completion === null) return COMPLETION_UNKNOWN;
  return Math.pow(completion, COMPLETION_EXPONENT);
}

/** Σ context bonuses, as the additive term inside (1 + Σ). */
export function contextBonusSum(input: EventValueInput): number {
  let sum = 0;
  if (input.sessionStarter) sum += CONTEXT_BONUS.sessionStarter;
  if (input.offline) sum += CONTEXT_BONUS.offline;
  if (input.sequencedAlbum) sum += CONTEXT_BONUS.sequencedAlbum;
  return sum;
}

/**
 * The EventValue for a single play. Pure — see module docs for the formula.
 */
export function eventValue(input: EventValueInput): number {
  const completion = rawCompletion(input.msPlayed, input.durationMs);
  const start = startWeight(input.reasonStart);
  const end = endFactor(input.reasonEnd, completion, input.msPlayed, input.skipped);
  const comp = completionFactor(completion);
  const ctx = 1 + contextBonusSum(input);
  return start * end * comp * ctx;
}
