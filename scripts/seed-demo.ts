/**
 * Seeds the local dev database with the demo user + synthetic fixture, then
 * computes tastegraphs and prints verification counts.
 *
 * Requires DATABASE_URL (loaded from .env if not already set, same minimal
 * loader worker/index.ts uses since tsx doesn't auto-load .env).
 *
 * Usage:
 *   tsx scripts/seed-demo.ts
 *   (or) npm run seed:demo
 *
 * Prerequisite: scripts/fixtures/demo_spotify_data.zip must exist — run
 * `npm run fixture` first if it doesn't.
 */

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

loadEnv();

if (!process.env.DATABASE_URL) {
  console.error(
    "[seed-demo] DATABASE_URL is required (set it in .env or the environment)."
  );
  process.exit(1);
}

async function main(): Promise<void> {
  // Imported after loadEnv() / DATABASE_URL check so Prisma always sees the
  // right connection string, and via relative paths (matching worker/index.ts's
  // convention for tsx-run scripts outside the Next.js "@/*" alias resolution).
  const { db } = await import("../lib/db");
  const { runImport } = await import("../lib/import/runImport");

  const zipPath = resolve(process.cwd(), "scripts/fixtures/demo_spotify_data.zip");
  if (!existsSync(zipPath)) {
    throw new Error(
      `Fixture not found at ${zipPath}. Run \`npm run fixture\` first to generate it.`
    );
  }

  console.log("[seed-demo] upserting demo user...");
  const user = await db.user.upsert({
    where: { spotifyId: "demo-user" },
    update: { displayName: "Demo" },
    create: { spotifyId: "demo-user", displayName: "Demo" },
  });
  console.log(`[seed-demo] user id: ${user.id}`);

  console.log(`[seed-demo] reading fixture: ${zipPath}`);
  const buffer = readFileSync(zipPath);

  console.log("[seed-demo] running import...");
  const importResult = await runImport(user.id, buffer, "demo_spotify_data.zip");
  console.log(
    `[seed-demo] import ${importResult.status}: total=${importResult.rowsTotal} ` +
      `imported=${importResult.rowsImported} skipped=${importResult.rowsSkipped}` +
      (importResult.error ? ` error=${importResult.error}` : "")
  );
  if (importResult.status !== "done") {
    throw new Error(`Import did not complete successfully (status=${importResult.status})`);
  }

  console.log("[seed-demo] computing tastegraphs...");
  const { computeAllTastegraphs } = await import("../lib/tastegraph/compute");
  await computeAllTastegraphs();
  console.log("[seed-demo] tastegraph computation done.");

  console.log("\n[seed-demo] === verification ===");

  const playsBySource = await db.play.groupBy({
    by: ["source"],
    where: { userId: user.id },
    _count: { _all: true },
  });
  console.log("\nplays by source:");
  for (const row of playsBySource) {
    console.log(`  ${row.source}: ${row._count._all}`);
  }

  const distinctTrackRows = await db.play.findMany({
    where: { userId: user.id },
    distinct: ["trackId"],
    select: { trackId: true },
  });
  const distinctTrackIds = distinctTrackRows.map((r) => r.trackId);
  const tracks =
    distinctTrackIds.length > 0
      ? await db.track.findMany({
          where: { id: { in: distinctTrackIds } },
          select: { artistName: true },
        })
      : [];
  const distinctArtistCount = new Set(tracks.map((t) => t.artistName)).size;
  console.log(`\ndistinct tracks played: ${distinctTrackIds.length}`);
  console.log(`distinct artists played: ${distinctArtistCount}`);

  const exportImportRow = await db.exportImport.findUnique({
    where: { id: importResult.id },
  });
  console.log("\nExportImport row:");
  console.log(
    `  status=${exportImportRow?.status} rowsTotal=${exportImportRow?.rowsTotal} ` +
      `rowsImported=${exportImportRow?.rowsImported} rowsSkipped=${exportImportRow?.rowsSkipped}`
  );

  const snapshotsByWindow = await db.tasteSnapshot.groupBy({
    by: ["window"],
    where: { userId: user.id },
    _count: { _all: true },
  });
  console.log("\nTasteSnapshot count by window:");
  for (const row of snapshotsByWindow.sort((a, b) => a.window.localeCompare(b.window))) {
    console.log(`  ${row.window}: ${row._count._all}`);
  }

  // TrackLifecycle / ListenerProfile: these tables are being built by other
  // in-flight work and may not exist in the Prisma client yet, so every
  // access here is defensive.
  console.log("\nTrackLifecycle / ListenerProfile (best-effort, may not exist yet):");
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dbAny = db as any;
    if (dbAny.trackLifecycle) {
      const count = await dbAny.trackLifecycle.count({ where: { userId: user.id } });
      console.log(`  TrackLifecycle rows: ${count}`);
      try {
        const quadrants = await dbAny.trackLifecycle.groupBy({
          by: ["quadrant"],
          where: { userId: user.id },
          _count: { _all: true },
        });
        console.log("  TrackLifecycle quadrant counts:");
        for (const row of quadrants) {
          console.log(`    ${row.quadrant}: ${row._count._all}`);
        }
      } catch (innerErr) {
        console.log(`  (quadrant breakdown unavailable: ${(innerErr as Error).message})`);
      }
    } else {
      console.log("  TrackLifecycle model not present on Prisma client yet — skipping.");
    }

    if (dbAny.listenerProfile) {
      const profile = await dbAny.listenerProfile.findUnique({ where: { userId: user.id } });
      console.log(`  ListenerProfile row: ${profile ? "present" : "missing"}`);
    } else {
      console.log("  ListenerProfile model not present on Prisma client yet — skipping.");
    }
  } catch (err) {
    console.warn(
      `  [seed-demo] TrackLifecycle/ListenerProfile verification skipped: ${(err as Error).message}`
    );
  }

  await db.$disconnect();
  console.log("\n[seed-demo] done.");
}

main().catch(async (err) => {
  console.error("\n[seed-demo] FAILED:", err);
  try {
    const { db } = await import("../lib/db");
    await db.$disconnect();
  } catch {
    // ignore
  }
  process.exit(1);
});

/**
 * Minimal .env loader (no external deps), mirroring worker/index.ts, so
 * `tsx scripts/seed-demo.ts` picks up the same variables as `next dev` does
 * automatically. Existing process.env values take precedence over the file.
 */
function loadEnv(): void {
  const envPath = resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) return;

  const contents = readFileSync(envPath, "utf8");
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
