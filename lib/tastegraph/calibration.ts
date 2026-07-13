/**
 * The calibration layer (DESIGN §6.1) — compute FIRST.
 *
 * These are listener meta-traits, not track scores. They normalize everything
 * downstream so a completion from a patient 2014-you and a trigger-happy 2026-you
 * are comparable. Computed with SQL aggregates (no 300k-row load) and upserted
 * into ListenerProfile.
 */

import { db } from "@/lib/db";

/** completionMultiplier bounds (the ×0.7–1.4 normalizer). */
export const COMPLETION_MULT_MIN = 0.7;
export const COMPLETION_MULT_MAX = 1.4;

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** restlessness → the completion multiplier: clamp(1.4 − restlessness, 0.7, 1.4). */
export function completionMultiplierFromRestlessness(restlessness: number): number {
  return clamp(COMPLETION_MULT_MAX - restlessness, COMPLETION_MULT_MIN, COMPLETION_MULT_MAX);
}

interface ScalarRow {
  restlessness: number | null;
  decisionDensity: number | null;
  shuffleSurrender: number | null;
}

interface ColdOpenRow {
  coldOpenTolerance: number | null;
}

interface DeadZoneRow {
  dow: number;
  hr: number;
  c: number;
}

export interface ListenerProfileResult {
  userId: string;
  restlessness: number;
  decisionDensity: number;
  shuffleSurrender: number;
  coldOpenTolerance: number;
  deadZones: number[];
  completionMultiplier: number;
}

/**
 * Computes and upserts the ListenerProfile for a user. Returns the computed
 * values (with the persisted deadZones as a flat 168-cell array).
 */
export async function computeListenerProfile(userId: string): Promise<ListenerProfileResult> {
  const [scalarRows, coldRows, deadRows] = await Promise.all([
    // restlessness, decisionDensity, shuffleSurrender in one pass.
    db.$queryRaw<ScalarRow[]>`
      SELECT
        -- restlessness: share of KNOWN-completion plays that were fwdbtn-rejected <25%
        (
          SUM(
            CASE WHEN p."reasonEnd" = 'fwdbtn'
                  AND p."msPlayed" IS NOT NULL AND t."durationMs" > 0
                  AND (p."msPlayed"::float8 / t."durationMs") < 0.25
                 THEN 1 ELSE 0 END
          )::float8
          / NULLIF(
              SUM(CASE WHEN p."msPlayed" IS NOT NULL AND t."durationMs" > 0 THEN 1 ELSE 0 END),
              0)
        ) AS "restlessness",
        -- decisionDensity: manual events per listening hour
        (
          SUM(
            (CASE WHEN p."reasonStart" IN ('clickrow','backbtn') THEN 1 ELSE 0 END)
            + (CASE WHEN p."reasonEnd" IN ('fwdbtn','backbtn') THEN 1 ELSE 0 END)
          )::float8
          / NULLIF(SUM(COALESCE(p."msPlayed", 0))::float8 / 3600000.0, 0)
        ) AS "decisionDensity",
        -- shuffleSurrender: passive-autoplay share of all plays
        (
          SUM(CASE WHEN p."shuffle" = true AND p."reasonStart" = 'trackdone' THEN 1 ELSE 0 END)::float8
          / NULLIF(COUNT(*), 0)
        ) AS "shuffleSurrender"
      FROM "Play" p
      JOIN "Track" t ON t.id = p."trackId"
      WHERE p."userId" = ${userId}
    `,
    // coldOpenTolerance: mean completion of each track's first-ever play when
    // that first play was a passive (trackdone) autoplay.
    db.$queryRaw<ColdOpenRow[]>`
      WITH firsts AS (
        SELECT DISTINCT ON (p."trackId")
          p."reasonStart" AS reason_start,
          p."msPlayed"    AS ms_played,
          t."durationMs"  AS duration_ms
        FROM "Play" p
        JOIN "Track" t ON t.id = p."trackId"
        WHERE p."userId" = ${userId}
        ORDER BY p."trackId", p."playedAt" ASC
      )
      SELECT AVG(LEAST(ms_played::float8 / duration_ms, 1)) AS "coldOpenTolerance"
      FROM firsts
      WHERE reason_start = 'trackdone'
        AND ms_played IS NOT NULL
        AND duration_ms > 0
    `,
    // deadZones: hour×weekday play-count grid (UTC).
    db.$queryRaw<DeadZoneRow[]>`
      SELECT
        EXTRACT(DOW  FROM p."playedAt")::int AS dow,
        EXTRACT(HOUR FROM p."playedAt")::int AS hr,
        COUNT(*)::int AS c
      FROM "Play" p
      WHERE p."userId" = ${userId}
      GROUP BY dow, hr
    `,
  ]);

  const scalar = scalarRows[0] ?? {
    restlessness: null,
    decisionDensity: null,
    shuffleSurrender: null,
  };

  const restlessness = scalar.restlessness ?? 0;
  const decisionDensity = scalar.decisionDensity ?? 0;
  const shuffleSurrender = scalar.shuffleSurrender ?? 0;
  const coldOpenTolerance = coldRows[0]?.coldOpenTolerance ?? 0;

  // Flatten the grid into 168 cells indexed weekday*24 + hour.
  const deadZones = new Array<number>(168).fill(0);
  for (const r of deadRows) {
    const idx = r.dow * 24 + r.hr;
    if (idx >= 0 && idx < 168) deadZones[idx] = r.c;
  }

  const completionMultiplier = completionMultiplierFromRestlessness(restlessness);

  const result: ListenerProfileResult = {
    userId,
    restlessness,
    decisionDensity,
    shuffleSurrender,
    coldOpenTolerance,
    deadZones,
    completionMultiplier,
  };

  await db.listenerProfile.upsert({
    where: { userId },
    create: {
      userId,
      restlessness,
      decisionDensity,
      shuffleSurrender,
      coldOpenTolerance,
      deadZones,
      completionMultiplier,
    },
    update: {
      restlessness,
      decisionDensity,
      shuffleSurrender,
      coldOpenTolerance,
      deadZones,
      completionMultiplier,
      computedAt: new Date(),
    },
  });

  return result;
}
