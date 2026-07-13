import Link from "next/link";
import { Prisma } from "@prisma/client";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { WINDOWS, windowStart, windowEnd } from "@/lib/tastegraph/windows";
import ImportCard, { type ImportRow } from "./ImportCard";

export const dynamic = "force-dynamic";

type SelectableWindow = (typeof WINDOWS)[number];

interface RankRow {
  entityId: string;
  name: string;
  sub: string | null;
  playCount: number;
  playPctAvg: number | null;
  score: number;
}

/** Builds the play-time WHERE fragment for a rolling/ALL/year window (fallback path). */
function timeClause(window: string, now: Date): Prisma.Sql {
  const start = windowStart(window, now);
  if (start === null) return Prisma.empty;
  const isYear = /^Y\d{4}$/.test(window);
  if (isYear) {
    return Prisma.sql`AND p."playedAt" >= ${start} AND p."playedAt" < ${windowEnd(window, now)}`;
  }
  return Prisma.sql`AND p."playedAt" >= ${start}`;
}

/** Top tracks/artists from the precomputed snapshots (score desc). */
async function snapshotRows(
  userId: string,
  window: string,
  entityType: "TRACK" | "ARTIST",
  take: number
): Promise<RankRow[]> {
  const snaps = await db.tasteSnapshot.findMany({
    where: { userId, window, entityType },
    orderBy: { score: "desc" },
    take,
  });
  if (snaps.length === 0) return [];

  const ids = snaps.map((s) => s.entityId);

  if (entityType === "TRACK") {
    const tracks = await db.track.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, artistName: true },
    });
    const byId = new Map(tracks.map((t) => [t.id, t]));
    return snaps.map((s) => ({
      entityId: s.entityId,
      name: byId.get(s.entityId)?.name ?? "(unknown track)",
      sub: byId.get(s.entityId)?.artistName ?? null,
      playCount: s.playCount,
      playPctAvg: s.playPctAvg,
      score: s.score,
    }));
  }

  // ARTIST: entityId is an artistId when known, else the artist name itself.
  const artists = await db.artist.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true },
  });
  const byId = new Map(artists.map((a) => [a.id, a.name]));
  return snaps.map((s) => ({
    entityId: s.entityId,
    name: byId.get(s.entityId) ?? s.entityId,
    sub: null,
    playCount: s.playCount,
    playPctAvg: s.playPctAvg,
    score: s.score,
  }));
}

/** Compute-on-read fallback: live top-by-playcount when no snapshots exist. */
async function liveTopTracks(
  userId: string,
  window: string,
  now: Date
): Promise<RankRow[]> {
  const rows = await db.$queryRaw<
    {
      entityId: string;
      name: string;
      sub: string;
      playCount: number;
      playPctAvg: number | null;
    }[]
  >`
    SELECT t.id AS "entityId", t.name AS "name", t."artistName" AS "sub",
      COUNT(*)::int AS "playCount",
      AVG(CASE WHEN p."msPlayed" IS NOT NULL AND t."durationMs" > 0
        THEN LEAST(p."msPlayed"::float8 / t."durationMs", 1) END)::float8 AS "playPctAvg"
    FROM "Play" p JOIN "Track" t ON t.id = p."trackId"
    WHERE p."userId" = ${userId} ${timeClause(window, now)}
    GROUP BY t.id, t.name, t."artistName"
    ORDER BY "playCount" DESC
    LIMIT 20
  `;
  return rows.map((r) => ({ ...r, score: r.playCount }));
}

async function liveTopArtists(
  userId: string,
  window: string,
  now: Date
): Promise<RankRow[]> {
  const rows = await db.$queryRaw<
    { entityId: string; name: string; playCount: number; playPctAvg: number | null }[]
  >`
    SELECT COALESCE(t."artistId", t."artistName") AS "entityId",
      MAX(t."artistName") AS "name",
      COUNT(*)::int AS "playCount",
      AVG(CASE WHEN p."msPlayed" IS NOT NULL AND t."durationMs" > 0
        THEN LEAST(p."msPlayed"::float8 / t."durationMs", 1) END)::float8 AS "playPctAvg"
    FROM "Play" p JOIN "Track" t ON t.id = p."trackId"
    WHERE p."userId" = ${userId} ${timeClause(window, now)}
    GROUP BY COALESCE(t."artistId", t."artistName")
    ORDER BY "playCount" DESC
    LIMIT 10
  `;
  return rows.map((r) => ({ ...r, sub: null, score: r.playCount }));
}

function fmtDate(d: Date | null): string {
  return d ? d.toISOString().slice(0, 10) : "—";
}

function fmtPct(v: number | null): string {
  return v === null ? "—" : `${Math.round(v * 100)}%`;
}

function RankList({ rows, label }: { rows: RankRow[]; label: string }) {
  const max = rows.reduce((m, r) => Math.max(m, r.score), 0) || 1;
  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-5">
      <h2 className="mb-3 font-mono text-xs uppercase tracking-widest text-[var(--color-text-muted)]">
        {label}
      </h2>
      {rows.length === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)]">No plays yet.</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {rows.map((r, i) => (
            <li key={r.entityId} className="flex items-center gap-3">
              <span className="w-6 shrink-0 text-right font-mono text-xs text-[var(--color-text-muted)]">
                {i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-sm text-[var(--color-text)]">
                    {r.name}
                    {r.sub && (
                      <span className="text-[var(--color-text-muted)]"> · {r.sub}</span>
                    )}
                  </span>
                  <span className="shrink-0 font-mono text-xs text-[var(--color-text-muted)]">
                    {r.playCount}× · {fmtPct(r.playPctAvg)}
                  </span>
                </div>
                <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-border)]">
                  <div
                    className="h-full rounded-full bg-[var(--color-accent)]"
                    style={{ width: `${Math.max(2, (r.score / max) * 100)}%` }}
                  />
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function SignInPrompt() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center gap-6 px-6 text-center">
      <h1 className="text-3xl font-semibold tracking-tight lowercase">deepcut</h1>
      <p className="max-w-md text-[var(--color-text-muted)]">
        Sign in with Spotify to see your tastegraph.
      </p>
      <Link
        href="/"
        className="rounded-full bg-[var(--color-accent)] px-6 py-3 text-sm font-medium text-black transition-colors hover:bg-[var(--color-accent-strong)]"
      >
        Go to sign in
      </Link>
    </main>
  );
}

function Stat({
  label,
  value,
  small,
}: {
  label: string;
  value: string;
  small?: boolean;
}) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-4">
      <dt className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
        {label}
      </dt>
      <dd className={`mt-1 ${small ? "text-xs" : "text-lg"} text-[var(--color-text)]`}>
        {value}
      </dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Quadrant map (DESIGN §3 — intensity × durability), from TrackLifecycle.
// ---------------------------------------------------------------------------

type QuadrantKey = "ALL_TIMER" | "CURRENT_OBSESSION" | "SLEEPER" | "PHASE";

interface QuadrantTile {
  key: QuadrantKey;
  label: string;
  blurb: string;
  count: number;
  top: string[];
}

const QUADRANT_META: Record<QuadrantKey, { label: string; blurb: string }> = {
  ALL_TIMER: { label: "All-Timers", blurb: "the canon" },
  CURRENT_OBSESSION: { label: "Current Obsessions", blurb: "honeymoon phase" },
  SLEEPER: { label: "Sleepers", blurb: "old faithfuls" },
  PHASE: { label: "Phases", blurb: "time capsules" },
};

async function loadQuadrants(userId: string): Promise<QuadrantTile[]> {
  const counts = await db.trackLifecycle.groupBy({
    by: ["quadrant"],
    where: { userId },
    _count: { _all: true },
  });
  const countByQuadrant = new Map(counts.map((c) => [c.quadrant, c._count._all]));

  const keys: QuadrantKey[] = ["ALL_TIMER", "CURRENT_OBSESSION", "SLEEPER", "PHASE"];
  const tiles = await Promise.all(
    keys.map(async (key) => {
      const top = await db.trackLifecycle.findMany({
        where: { userId, quadrant: key },
        orderBy: { coreScore: "desc" },
        take: 3,
        select: { track: { select: { name: true } } },
      });
      return {
        key,
        label: QUADRANT_META[key].label,
        blurb: QUADRANT_META[key].blurb,
        count: countByQuadrant.get(key) ?? 0,
        top: top.map((t) => t.track.name),
      };
    })
  );
  return tiles;
}

function QuadrantMap({ tiles }: { tiles: QuadrantTile[] }) {
  const total = tiles.reduce((s, t) => s + t.count, 0);
  if (total === 0) return null;
  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-5">
      <h2 className="mb-4 font-mono text-xs uppercase tracking-widest text-[var(--color-text-muted)]">
        Taste map · intensity × durability
      </h2>
      <div className="grid grid-cols-2 gap-3">
        {tiles.map((t) => (
          <div
            key={t.key}
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4"
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-sm font-medium text-[var(--color-text)]">{t.label}</span>
              <span className="font-mono text-xs text-[var(--color-accent)]">{t.count}</span>
            </div>
            <p className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
              {t.blurb}
            </p>
            <ul className="mt-2 space-y-0.5">
              {t.top.length === 0 ? (
                <li className="text-xs text-[var(--color-text-muted)]">—</li>
              ) : (
                t.top.map((name, i) => (
                  <li key={i} className="truncate text-xs text-[var(--color-text-muted)]">
                    {name}
                  </li>
                ))
              )}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Desert-Island Core (DESIGN §6.4) — smallest set of tracks covering 50% of
// lifetime msPlayed that appear in EVERY calendar year with plays.
// ---------------------------------------------------------------------------

interface DesertIslandTrack {
  trackId: string;
  name: string;
  artist: string;
  ms: number;
}

async function loadDesertIsland(
  userId: string,
  totalMs: number
): Promise<{ tracks: DesertIslandTrack[]; setSize: number }> {
  if (totalMs <= 0) return { tracks: [], setSize: 0 };

  const rows = await db.$queryRaw<
    { trackId: string; name: string; artist: string; ms: bigint }[]
  >`
    WITH years AS (
      SELECT DISTINCT EXTRACT(YEAR FROM p."playedAt")::int AS yr
      FROM "Play" p WHERE p."userId" = ${userId}
    ),
    track_years AS (
      SELECT
        p."trackId" AS "trackId",
        COUNT(DISTINCT EXTRACT(YEAR FROM p."playedAt")) AS ny,
        SUM(COALESCE(p."msPlayed", 0))::bigint AS ms
      FROM "Play" p WHERE p."userId" = ${userId}
      GROUP BY p."trackId"
    )
    SELECT ty."trackId" AS "trackId", t.name AS "name", t."artistName" AS "artist", ty.ms AS "ms"
    FROM track_years ty JOIN "Track" t ON t.id = ty."trackId"
    WHERE ty.ny = (SELECT COUNT(*) FROM years)
    ORDER BY ty.ms DESC
  `;

  // Greedy largest-first until cumulative ms covers 50% of lifetime ms.
  const target = totalMs * 0.5;
  const picked: DesertIslandTrack[] = [];
  let cum = 0;
  for (const r of rows) {
    const ms = Number(r.ms);
    picked.push({ trackId: r.trackId, name: r.name, artist: r.artist, ms });
    cum += ms;
    if (cum >= target) break;
  }
  return { tracks: picked, setSize: picked.length };
}

function DesertIslandCore({
  tracks,
  setSize,
}: {
  tracks: DesertIslandTrack[];
  setSize: number;
}) {
  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-5">
      <h2 className="font-mono text-xs uppercase tracking-widest text-[var(--color-text-muted)]">
        Desert-Island Core
      </h2>
      {tracks.length === 0 ? (
        <p className="mt-3 text-sm text-[var(--color-text-muted)]">
          Not enough history across years yet.
        </p>
      ) : (
        <>
          <p className="mt-1 text-sm text-[var(--color-text)]">
            {setSize} {setSize === 1 ? "track" : "tracks"} are half of everything you&rsquo;ve
            ever played — and you&rsquo;ve returned to each one every single year.
          </p>
          <ol className="mt-3 flex flex-col gap-1.5">
            {tracks.slice(0, 12).map((t, i) => (
              <li key={t.trackId} className="flex items-center gap-3">
                <span className="w-5 shrink-0 text-right font-mono text-xs text-[var(--color-text-muted)]">
                  {i + 1}
                </span>
                <span className="truncate text-sm text-[var(--color-text)]">
                  {t.name}
                  <span className="text-[var(--color-text-muted)]"> · {t.artist}</span>
                </span>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Listener profile strip (DESIGN §6.1) — calibration meta-traits as meters.
// ---------------------------------------------------------------------------

interface ProfileMeter {
  label: string;
  value: number; // 0-1 for the bar
  line: string;
}

function buildProfileMeters(p: {
  restlessness: number;
  decisionDensity: number;
  shuffleSurrender: number;
}): ProfileMeter[] {
  const restBar = Math.min(1, Math.max(0, p.restlessness));
  const ddBar = Math.min(1, p.decisionDensity / 30); // ~30 manual events/hr ≈ very hands-on
  const shufBar = Math.min(1, Math.max(0, p.shuffleSurrender));
  return [
    {
      label: "Restlessness",
      value: restBar,
      line:
        restBar >= 0.5
          ? "quick on the skip button"
          : restBar >= 0.2
            ? "you give songs a fair shot"
            : "you let songs breathe all the way",
    },
    {
      label: "Decision density",
      value: ddBar,
      line:
        ddBar >= 0.5
          ? "you steer nearly every song"
          : ddBar >= 0.2
            ? "a mix of picking and coasting"
            : "you mostly let it ride",
    },
    {
      label: "Shuffle surrender",
      value: shufBar,
      line:
        shufBar >= 0.6
          ? "mostly lean-back, algorithm-fed listening"
          : shufBar >= 0.3
            ? "half chosen, half autopilot"
            : "you pick what plays",
    },
  ];
}

function ProfileStrip({ meters }: { meters: ProfileMeter[] }) {
  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-5">
      <h2 className="mb-4 font-mono text-xs uppercase tracking-widest text-[var(--color-text-muted)]">
        How you listen
      </h2>
      <div className="grid gap-4 sm:grid-cols-3">
        {meters.map((m) => (
          <div key={m.label}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-sm text-[var(--color-text)]">{m.label}</span>
              <span className="font-mono text-xs text-[var(--color-text-muted)]">
                {Math.round(m.value * 100)}
              </span>
            </div>
            <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-border)]">
              <div
                className="h-full rounded-full bg-[var(--color-accent)]"
                style={{ width: `${Math.max(2, m.value * 100)}%` }}
              />
            </div>
            <p className="mt-1.5 text-xs text-[var(--color-text-muted)]">{m.line}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function PlaylistsLinkCard({ count }: { count: number }) {
  return (
    <Link
      href="/playlists"
      className="group flex items-center justify-between rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-5 transition-colors hover:border-[var(--color-accent)]"
    >
      <div>
        <h2 className="font-mono text-xs uppercase tracking-widest text-[var(--color-text-muted)]">
          Your playlists
        </h2>
        <p className="mt-1 text-sm text-[var(--color-text)]">
          {count > 0
            ? `${count} generated from your listening`
            : "generated after your next nightly compute"}
        </p>
      </div>
      <span className="font-mono text-lg text-[var(--color-accent)] transition-transform group-hover:translate-x-1">
        →
      </span>
    </Link>
  );
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ window?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) return <SignInPrompt />;

  const params = await searchParams;
  const selected: SelectableWindow = (WINDOWS as readonly string[]).includes(
    params.window ?? ""
  )
    ? (params.window as SelectableWindow)
    : "ALL";

  const now = new Date();

  const [totals, range, account, snapTracks, snapArtists, importRows] =
    await Promise.all([
      db.play.aggregate({
        where: { userId: user.id },
        _count: { _all: true },
        _sum: { msPlayed: true },
      }),
      db.play.aggregate({
        where: { userId: user.id },
        _min: { playedAt: true },
        _max: { playedAt: true },
      }),
      db.spotifyAccount.findUnique({
        where: { userId: user.id },
        select: { lastPolledAt: true },
      }),
      snapshotRows(user.id, selected, "TRACK", 20),
      snapshotRows(user.id, selected, "ARTIST", 10),
      db.exportImport.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "desc" },
        take: 10,
      }),
    ]);

  // Fallback to a live query when the nightly snapshots haven't been built yet.
  const snapshotPending = snapTracks.length === 0 && snapArtists.length === 0;
  const tracks = snapshotPending
    ? await liveTopTracks(user.id, selected, now)
    : snapTracks;
  const artists = snapshotPending
    ? await liveTopArtists(user.id, selected, now)
    : snapArtists;

  const totalPlays = totals._count._all;
  const totalMsPlayed = Number(totals._sum.msPlayed ?? 0);
  const totalHours = (totalMsPlayed / 3_600_000).toFixed(1);

  // Tastegraph v1 dashboard cards (all derived from TrackLifecycle / Play /
  // ListenerProfile that the nightly compute produced).
  const [quadrants, desertIsland, profile, playlistCount] = await Promise.all([
    loadQuadrants(user.id),
    loadDesertIsland(user.id, totalMsPlayed),
    db.listenerProfile.findUnique({ where: { userId: user.id } }),
    db.generatedPlaylist.count({ where: { userId: user.id } }),
  ]);
  const meters = profile ? buildProfileMeters(profile) : null;

  const initialImports: ImportRow[] = importRows.map((r) => ({
    id: r.id,
    filename: r.filename,
    status: r.status,
    rowsTotal: r.rowsTotal,
    rowsImported: r.rowsImported,
    rowsSkipped: r.rowsSkipped,
    createdAt: r.createdAt.toISOString(),
  }));

  const pollStatus = account?.lastPolledAt
    ? `live tracking active — last check ${Math.max(
        0,
        Math.round((now.getTime() - account.lastPolledAt.getTime()) / 60_000)
      )} min ago`
    : "waiting for first poll";

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 px-6 py-12">
      {/* Header */}
      <header className="flex flex-col gap-4">
        <div className="flex items-center gap-4">
          {user.imageUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={user.imageUrl}
              alt=""
              className="h-12 w-12 rounded-full border border-[var(--color-border)]"
            />
          )}
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              {user.displayName ?? "Your tastegraph"}
            </h1>
            <p className="font-mono text-xs text-[var(--color-text-muted)]">
              {pollStatus}
            </p>
          </div>
        </div>

        <dl className="grid grid-cols-3 gap-3">
          <Stat label="plays" value={totalPlays.toLocaleString()} />
          <Stat label="hours" value={totalHours} />
          <Stat
            label="range"
            value={`${fmtDate(range._min.playedAt)} → ${fmtDate(range._max.playedAt)}`}
            small
          />
        </dl>
      </header>

      {/* Window switcher */}
      <nav className="flex flex-wrap gap-2">
        {WINDOWS.map((w) => (
          <Link
            key={w}
            href={`/dashboard?window=${w}`}
            className={`rounded-full border px-4 py-1.5 font-mono text-xs uppercase tracking-widest transition-colors ${
              w === selected
                ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-black"
                : "border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-text)]"
            }`}
          >
            {w}
          </Link>
        ))}
      </nav>

      {snapshotPending && totalPlays > 0 && (
        <p className="font-mono text-xs text-[var(--color-text-muted)]">
          snapshot pending — nightly compute. Showing live top-by-playcount.
        </p>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        <RankList rows={tracks} label={`Top tracks · ${selected}`} />
        <RankList rows={artists} label={`Top artists · ${selected}`} />
      </div>

      {meters && <ProfileStrip meters={meters} />}

      <div className="grid gap-6 md:grid-cols-2">
        <QuadrantMap tiles={quadrants} />
        <DesertIslandCore tracks={desertIsland.tracks} setSize={desertIsland.setSize} />
      </div>

      <PlaylistsLinkCard count={playlistCount} />

      <ImportCard initialImports={initialImports} />
    </main>
  );
}
