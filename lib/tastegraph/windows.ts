/**
 * Rolling + all-time windows used when computing TasteSnapshot rows.
 * Year windows (e.g. "Y2026") are computed on demand and are not part of
 * this fixed list, but windowStart/windowEnd both understand them.
 */
export const WINDOWS = ["ALL", "R30", "R90", "R180", "R360"] as const;

export type Window = (typeof WINDOWS)[number] | `Y${number}`;

const YEAR_WINDOW_RE = /^Y(\d{4})$/;
const ROLLING_DAYS: Record<string, number> = {
  R30: 30,
  R90: 90,
  R180: 180,
  R360: 360,
};

/**
 * Returns the inclusive start of the window relative to `now`, or `null` for
 * "ALL" (no lower bound). Year windows (e.g. "Y2026") start Jan 1 of that year.
 */
export function windowStart(window: string, now: Date): Date | null {
  if (window === "ALL") {
    return null;
  }

  const rollingDays = ROLLING_DAYS[window];
  if (rollingDays !== undefined) {
    const start = new Date(now);
    start.setDate(start.getDate() - rollingDays);
    return start;
  }

  const yearMatch = YEAR_WINDOW_RE.exec(window);
  if (yearMatch) {
    const year = Number(yearMatch[1]);
    return new Date(Date.UTC(year, 0, 1, 0, 0, 0, 0));
  }

  throw new Error(`Unknown window: ${window}`);
}

/**
 * Returns the exclusive end of the window relative to `now`. For rolling
 * windows and "ALL" this is just `now`. For year windows it's Jan 1 of the
 * following year (so a completed past year is not truncated at `now`).
 */
export function windowEnd(window: string, now: Date): Date {
  if (window === "ALL" || ROLLING_DAYS[window] !== undefined) {
    return now;
  }

  const yearMatch = YEAR_WINDOW_RE.exec(window);
  if (yearMatch) {
    const year = Number(yearMatch[1]);
    return new Date(Date.UTC(year + 1, 0, 1, 0, 0, 0, 0));
  }

  throw new Error(`Unknown window: ${window}`);
}
