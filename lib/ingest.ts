import type { Prisma, PrismaClient, Track } from "@prisma/client";

/**
 * Shared ingest helpers used by both the recently-played poller (worker/poll.ts)
 * and the export importer (Spotify "Extended Streaming History" zip). Both accept
 * either the top-level PrismaClient or a $transaction callback client so callers
 * can batch a whole page/file of rows atomically.
 */
export type Db = PrismaClient | Prisma.TransactionClient;

export interface UpsertTrackInput {
  spotifyUri: string;
  name: string;
  artistName: string;
  albumName?: string | null;
  durationMs?: number | null;
}

/**
 * Upserts a Track by its Spotify URI, keeping artistName/albumName/durationMs
 * in sync. The related Artist is found-or-created by name (we don't always know
 * the artist's own Spotify URI at ingest time, e.g. from export rows).
 * Returns the track id.
 */
export async function upsertTrack(db: Db, input: UpsertTrackInput): Promise<string> {
  const { spotifyUri, name, artistName, albumName = null, durationMs = null } = input;

  let artist = await db.artist.findFirst({ where: { name: artistName } });
  if (!artist) {
    artist = await db.artist.create({ data: { name: artistName } });
  }

  const track: Track = await db.track.upsert({
    where: { spotifyUri },
    create: {
      spotifyUri,
      name,
      artistName,
      albumName,
      durationMs,
      artistId: artist.id,
    },
    update: {
      name,
      artistName,
      albumName,
      durationMs,
      artistId: artist.id,
    },
  });

  return track.id;
}

export interface InsertPlayInput {
  userId: string;
  trackId: string;
  playedAt: Date;
  source: "POLL" | "EXPORT" | "EXPORT_ACCOUNT";
  msPlayed?: number | null;
  skipped?: boolean | null;
  reasonStart?: string | null;
  reasonEnd?: string | null;
  shuffle?: boolean | null;
  context?: string | null;
}

export interface InsertPlayResult {
  inserted: boolean;
}

const UNIQUE_CONSTRAINT_ERROR_CODE = "P2002";

/**
 * Inserts a Play row, treating a unique-constraint violation on
 * (userId, trackId, playedAt) as an expected duplicate rather than an error —
 * both the poller and the export importer will naturally re-see the same plays.
 */
export async function insertPlay(db: Db, input: InsertPlayInput): Promise<InsertPlayResult> {
  const {
    userId,
    trackId,
    playedAt,
    source,
    msPlayed = null,
    skipped = null,
    reasonStart = null,
    reasonEnd = null,
    shuffle = null,
    context = null,
  } = input;

  try {
    await db.play.create({
      data: {
        userId,
        trackId,
        playedAt,
        source,
        msPlayed,
        skipped,
        reasonStart,
        reasonEnd,
        shuffle,
        context,
      },
    });
    return { inserted: true };
  } catch (err: unknown) {
    if (isUniqueConstraintError(err)) {
      return { inserted: false };
    }
    throw err;
  }
}

function isUniqueConstraintError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === UNIQUE_CONSTRAINT_ERROR_CODE
  );
}
