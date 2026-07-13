import { db } from "@/lib/db";
import { upsertTrack, insertPlay } from "@/lib/ingest";
import { parseExport, type NormalizedPlay } from "@/lib/import/parseExport";
import type { ExportImport } from "@prisma/client";

/**
 * Runs a full export import for a user: parses the ZIP, then batch-ingests the
 * normalized plays (upsertTrack + insertPlay) in chunks inside transactions.
 *
 * Dedupe happens on three levels:
 *  1. The unique [userId, trackId, playedAt] constraint dedupes re-imports of
 *     the same export (handled inside insertPlay).
 *  2. Cross-source: an EXPORT play is skipped if a POLL play already exists for
 *     the same user+track within ±120s (the poller is authoritative for live
 *     data — we don't want the export to double-count it). POLL plays for each
 *     batch's time range are fetched once and matched in memory.
 */

const CHUNK_SIZE = 500;
const POLL_DEDUPE_WINDOW_MS = 120_000;

export async function runImport(
  userId: string,
  zipBuffer: Buffer,
  filename: string
): Promise<ExportImport> {
  const record = await db.exportImport.create({
    data: { userId, filename, status: "processing" },
  });

  let rowsTotal = 0;
  let rowsImported = 0;
  let rowsSkipped = 0;

  try {
    const plays = parseExport(zipBuffer);
    rowsTotal = plays.length;

    for (let i = 0; i < plays.length; i += CHUNK_SIZE) {
      const chunk = plays.slice(i, i + CHUNK_SIZE);
      const { imported, skipped } = await processChunk(userId, chunk);
      rowsImported += imported;
      rowsSkipped += skipped;
    }

    return await db.exportImport.update({
      where: { id: record.id },
      data: {
        status: "done",
        rowsTotal,
        rowsImported,
        rowsSkipped,
        completedAt: new Date(),
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return await db.exportImport.update({
      where: { id: record.id },
      data: {
        status: "error",
        error: message.slice(0, 1000),
        rowsTotal,
        rowsImported,
        rowsSkipped,
        completedAt: new Date(),
      },
    });
  }
}

interface ChunkResult {
  imported: number;
  skipped: number;
}

async function processChunk(
  userId: string,
  chunk: NormalizedPlay[]
): Promise<ChunkResult> {
  // Compute the batch's time range (padded by the dedupe window) and pull the
  // user's POLL plays inside it once, keyed by trackId → sorted playedAt ms.
  let minMs = Number.POSITIVE_INFINITY;
  let maxMs = Number.NEGATIVE_INFINITY;
  for (const p of chunk) {
    const ms = Date.parse(p.tsISO);
    if (ms < minMs) minMs = ms;
    if (ms > maxMs) maxMs = ms;
  }

  const pollByTrack = new Map<string, number[]>();
  if (Number.isFinite(minMs) && Number.isFinite(maxMs)) {
    const pollPlays = await db.play.findMany({
      where: {
        userId,
        source: "POLL",
        playedAt: {
          gte: new Date(minMs - POLL_DEDUPE_WINDOW_MS),
          lte: new Date(maxMs + POLL_DEDUPE_WINDOW_MS),
        },
      },
      select: { trackId: true, playedAt: true },
    });
    for (const play of pollPlays) {
      const arr = pollByTrack.get(play.trackId) ?? [];
      arr.push(play.playedAt.getTime());
      pollByTrack.set(play.trackId, arr);
    }
  }

  let imported = 0;
  let skipped = 0;

  await db.$transaction(
    async (tx) => {
      for (const p of chunk) {
        const trackId = await upsertTrack(tx, {
          spotifyUri: p.spotifyUri,
          name: p.trackName,
          artistName: p.artistName,
          albumName: p.albumName,
        });

        const playedAt = new Date(p.tsISO);

        // Cross-source dedupe against live POLL data.
        const pollTimes = pollByTrack.get(trackId);
        if (pollTimes && hasNearbyTime(pollTimes, playedAt.getTime())) {
          skipped++;
          continue;
        }

        const { inserted } = await insertPlay(tx, {
          userId,
          trackId,
          playedAt,
          source: p.source,
          msPlayed: p.msPlayed,
          skipped: p.skipped,
          reasonStart: p.reasonStart,
          reasonEnd: p.reasonEnd,
          shuffle: p.shuffle,
        });

        if (inserted) {
          imported++;
        } else {
          skipped++;
        }
      }
    },
    { timeout: 120_000, maxWait: 120_000 }
  );

  return { imported, skipped };
}

function hasNearbyTime(sortedOrUnsorted: number[], targetMs: number): boolean {
  for (const t of sortedOrUnsorted) {
    if (Math.abs(t - targetMs) <= POLL_DEDUPE_WINDOW_MS) return true;
  }
  return false;
}
