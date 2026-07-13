/**
 * Session reconstruction (DESIGN §3 build order, unlocks §6.2 sequence signals).
 *
 * A listening session is a run of plays with no ≥30-min gap between them. The
 * gap is measured end-to-start: from the previous play's end (its `playedAt`,
 * which is the end-of-stream timestamp) to this play's approximate *start*
 * (`playedAt − msPlayed`, falling back to `playedAt − durationMs`, then
 * `playedAt`).
 *
 * `buildSessions` is a pure function so it can be reused two ways:
 *   - `sessionizeUser` persists the resulting `sessionId` onto Play rows, and
 *   - the scorer (lifecycle.ts) re-derives the per-play `sessionStarter` and
 *     `sequencedAlbum` flags in memory at compute time (they are ephemeral —
 *     only `sessionId` is a real column).
 */

import { db } from "@/lib/db";

/** 30-minute session-break gap. */
export const SESSION_GAP_MS = 30 * 60 * 1000;

/** reason_start values that count as an intentional session opener. */
export const INTENTIONAL_STARTS = new Set(["clickrow", "search", "playbtn", "backbtn"]);

/** Minimum consecutive same-album plays to count as a sequenced-album run. */
export const SEQUENCED_ALBUM_MIN = 3;

export interface PlayForSession {
  id: string;
  playedAt: Date;
  msPlayed: number | null;
  durationMs: number | null;
  reasonStart: string | null;
  shuffle: boolean | null;
  /** album identity for the sequenced-album run detector (albumName ?? null) */
  album: string | null;
  /** current persisted sessionId, used to skip no-op writes */
  sessionId?: string | null;
}

export interface SessionedPlay extends PlayForSession {
  /** `${userId}:${firstPlayISO}` — stable per session */
  newSessionId: string;
  /** first intentional play of the session after the gap */
  sessionStarter: boolean;
  /** shuffle=false and inside a ≥3 in-order same-album run */
  sequencedAlbum: boolean;
}

/** Approximate start instant of a play (ms epoch). */
function startMs(p: PlayForSession): number {
  const end = p.playedAt.getTime();
  if (p.msPlayed !== null && p.msPlayed !== undefined) return end - p.msPlayed;
  if (p.durationMs !== null && p.durationMs !== undefined) return end - p.durationMs;
  return end;
}

/**
 * Assigns sessions + derived flags to a chronologically-orderable list of plays.
 * Pure; sorts a copy by playedAt ascending. `userId` seeds the sessionId prefix.
 */
export function buildSessions(userId: string, plays: PlayForSession[]): SessionedPlay[] {
  const sorted = [...plays].sort((a, b) => a.playedAt.getTime() - b.playedAt.getTime());
  const out: SessionedPlay[] = [];

  let currentSessionId = "";
  let prevEndMs = Number.NEGATIVE_INFINITY;
  let seenIntentionalStarter = false;

  for (const p of sorted) {
    const thisStart = startMs(p);
    const isNewSession =
      out.length === 0 || thisStart - prevEndMs >= SESSION_GAP_MS;

    if (isNewSession) {
      currentSessionId = `${userId}:${p.playedAt.toISOString()}`;
      seenIntentionalStarter = false;
    }

    const intentional = p.reasonStart !== null && INTENTIONAL_STARTS.has(p.reasonStart);
    // The session-starter bonus goes to the first intentional play after the gap.
    const sessionStarter = !seenIntentionalStarter && intentional;
    if (sessionStarter) seenIntentionalStarter = true;

    out.push({
      ...p,
      newSessionId: currentSessionId,
      sessionStarter,
      sequencedAlbum: false, // filled in by the run pass below
    });

    prevEndMs = p.playedAt.getTime();
  }

  markSequencedAlbums(out);
  return out;
}

/**
 * Marks plays that sit inside a run of ≥3 consecutive same-album, shuffle=false
 * plays (approximation of DESIGN §1 "sequenced album session").
 */
function markSequencedAlbums(plays: SessionedPlay[]): void {
  let runStart = 0;
  const flagRun = (start: number, end: number) => {
    if (end - start >= SEQUENCED_ALBUM_MIN) {
      for (let i = start; i < end; i++) plays[i].sequencedAlbum = true;
    }
  };

  for (let i = 1; i <= plays.length; i++) {
    const prev = plays[i - 1];
    const cur = i < plays.length ? plays[i] : null;
    const continues =
      cur !== null &&
      cur.shuffle === false &&
      prev.shuffle === false &&
      cur.album !== null &&
      cur.album === prev.album;
    if (!continues) {
      flagRun(runStart, i);
      runStart = i;
    }
  }
}

const UPDATE_CHUNK = 1000;

export interface SessionizeResult {
  totalPlays: number;
  sessionsFound: number;
  playsUpdated: number;
}

/**
 * Recomputes and persists `sessionId` for every play of a user.
 *
 * Sessionization is inherently global (it needs all plays in order), so we load
 * a projection of every play once, compute sessions in memory, and only write
 * the rows whose sessionId actually changed — unless `recompute` forces a full
 * rewrite. Writes are batched by sessionId in chunks of {@link UPDATE_CHUNK}.
 */
export async function sessionizeUser(
  userId: string,
  opts: { recompute?: boolean } = {}
): Promise<SessionizeResult> {
  const recompute = opts.recompute ?? false;

  const rows = await loadPlaysForSession(userId);
  if (rows.length === 0) {
    return { totalPlays: 0, sessionsFound: 0, playsUpdated: 0 };
  }

  const sessioned = buildSessions(userId, rows);

  // Group play ids by their target sessionId, keeping only rows that need a write.
  const bySession = new Map<string, string[]>();
  const sessionIds = new Set<string>();
  for (const p of sessioned) {
    sessionIds.add(p.newSessionId);
    const needsWrite = recompute || p.sessionId !== p.newSessionId;
    if (!needsWrite) continue;
    const bucket = bySession.get(p.newSessionId);
    if (bucket) bucket.push(p.id);
    else bySession.set(p.newSessionId, [p.id]);
  }

  let playsUpdated = 0;
  for (const [sessionId, ids] of bySession) {
    for (let i = 0; i < ids.length; i += UPDATE_CHUNK) {
      const chunk = ids.slice(i, i + UPDATE_CHUNK);
      const res = await db.play.updateMany({
        where: { id: { in: chunk } },
        data: { sessionId },
      });
      playsUpdated += res.count;
    }
  }

  return {
    totalPlays: sessioned.length,
    sessionsFound: sessionIds.size,
    playsUpdated,
  };
}

const LOAD_CHUNK = 10_000;

/**
 * Streams a small projection of every play (+ its track's duration/album),
 * ordered by playedAt, paginated by id cursor to avoid one huge query.
 */
async function loadPlaysForSession(userId: string): Promise<PlayForSession[]> {
  const out: PlayForSession[] = [];
  let cursorId: string | undefined;

  for (;;) {
    const page = await db.play.findMany({
      where: { userId },
      orderBy: { id: "asc" },
      take: LOAD_CHUNK,
      ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
      select: {
        id: true,
        playedAt: true,
        msPlayed: true,
        reasonStart: true,
        shuffle: true,
        sessionId: true,
        track: { select: { durationMs: true, albumName: true } },
      },
    });
    if (page.length === 0) break;

    for (const r of page) {
      out.push({
        id: r.id,
        playedAt: r.playedAt,
        msPlayed: r.msPlayed,
        durationMs: r.track.durationMs,
        reasonStart: r.reasonStart,
        shuffle: r.shuffle,
        album: r.track.albumName,
        sessionId: r.sessionId,
      });
    }

    if (page.length < LOAD_CHUNK) break;
    cursorId = page[page.length - 1].id;
  }

  return out;
}
