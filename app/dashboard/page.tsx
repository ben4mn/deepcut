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
  const totalHours = ((totals._sum.msPlayed ?? 0) / 3_600_000).toFixed(1);

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

      <ImportCard initialImports={initialImports} />
    </main>
  );
}
