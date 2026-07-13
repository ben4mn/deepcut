import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function SignInPrompt() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center gap-6 px-6 text-center">
      <h1 className="text-3xl font-semibold tracking-tight lowercase">deepcut</h1>
      <p className="max-w-md text-[var(--color-text-muted)]">
        Sign in with Spotify to see this playlist.
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

export default async function PlaylistDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) return <SignInPrompt />;

  const { id } = await params;

  const playlist = await db.generatedPlaylist.findFirst({
    // scoped to the user so ids can't be enumerated across accounts
    where: { id, userId: user.id },
    select: {
      title: true,
      description: true,
      generatedAt: true,
      items: {
        orderBy: { position: "asc" },
        select: {
          id: true,
          stat: true,
          track: { select: { name: true, artistName: true } },
        },
      },
    },
  });

  if (!playlist) notFound();

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 px-6 py-12">
      <header className="flex flex-col gap-3">
        <Link
          href="/playlists"
          className="self-start font-mono text-xs uppercase tracking-widest text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)]"
        >
          ← playlists
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{playlist.title}</h1>
        <p className="text-sm text-[var(--color-text-muted)]">{playlist.description}</p>
        <p className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
          {playlist.items.length} tracks · generated {fmtDate(playlist.generatedAt)}
        </p>
      </header>

      <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-5">
        <ol className="flex flex-col gap-3">
          {playlist.items.map((it, i) => (
            <li key={it.id} className="flex items-start gap-3">
              <span className="w-6 shrink-0 pt-0.5 text-right font-mono text-xs text-[var(--color-text-muted)]">
                {i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-[var(--color-text)]">
                  {it.track.name}
                  <span className="text-[var(--color-text-muted)]"> · {it.track.artistName}</span>
                </div>
                {it.stat && (
                  <div className="font-mono text-[11px] text-[var(--color-accent)]">{it.stat}</div>
                )}
              </div>
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
