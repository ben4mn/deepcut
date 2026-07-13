/**
 * Playlist portfolio entry point (DESIGN §7). generateAllPlaylists builds every
 * playlist spec (lib/playlists/generators.ts) and persists it with a
 * delete-and-recreate per (user, kind) inside a transaction — so a refresh
 * replaces a kind's playlists wholesale and stale kinds (that no longer
 * qualify) are cleared out.
 *
 * Called at the end of the nightly compute pipeline
 * (lib/tastegraph/compute.ts) once TrackLifecycle rows exist.
 */

import { db } from "@/lib/db";
import { buildPlaylistSpecs, type PlaylistKind, type PlaylistSpec } from "./generators";

export { buildPlaylistSpecs } from "./generators";
export type { PlaylistKind, PlaylistSpec, PlaylistItemSpec } from "./generators";

/** Every kind we manage — so a kind that produced nothing this run is cleared. */
const ALL_KINDS: PlaylistKind[] = [
  "TOP_ALL_TIME",
  "HEAVY_ROTATION",
  "FULL_SEND",
  "ONE_NIGHT_ONLY",
  "GATEWAY_DRUGS",
  "THIS_WEEK_EVERY_YEAR",
  "COMEBACK_KIDS",
  "RESURRECTION",
  "ONE_HIT_WONDER",
  "NEW_BLOOD",
  "ON_THE_WAY_OUT",
  "ONE_ARTIST_ERA",
];

export interface GenerateResult {
  playlists: number;
  items: number;
}

/**
 * Regenerates all of a user's playlists. Returns counts for logging.
 */
export async function generateAllPlaylists(userId: string, now: Date): Promise<GenerateResult> {
  const specs = await buildPlaylistSpecs(userId, now);

  const byKind = new Map<PlaylistKind, PlaylistSpec[]>();
  for (const kind of ALL_KINDS) byKind.set(kind, []);
  for (const spec of specs) byKind.get(spec.kind)!.push(spec);

  let playlists = 0;
  let items = 0;

  // One transaction per kind: delete the old, create the new.
  for (const kind of ALL_KINDS) {
    const kindSpecs = byKind.get(kind)!;
    await db.$transaction(async (tx) => {
      await tx.generatedPlaylist.deleteMany({ where: { userId, kind } });
      for (const spec of kindSpecs) {
        if (spec.items.length === 0) continue;
        await tx.generatedPlaylist.create({
          data: {
            userId,
            kind: spec.kind,
            title: spec.title,
            description: spec.description,
            generatedAt: now,
            meta: spec.meta,
            items: {
              create: spec.items.map((it) => ({
                trackId: it.trackId,
                position: it.position,
                stat: it.stat,
              })),
            },
          },
        });
        playlists++;
        items += spec.items.length;
      }
    });
  }

  return { playlists, items };
}
