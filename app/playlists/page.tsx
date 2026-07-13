import Link from "next/link";
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
        Sign in with Spotify to see your playlists.
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

export default async function PlaylistsPage() {
  const user = await getCurrentUser();
  if (!user) return <SignInPrompt />;

  const playlists = await db.generatedPlaylist.findMany({
    where: { userId: user.id },
    orderBy: [{ kind: "asc" }, { generatedAt: "desc" }],
    select: {
      id: true,
      title: true,
      description: true,
      generatedAt: true,
      _count: { select: { items: true } },
    },
  });

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 px-6 py-12">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Your playlists</h1>
          <p className="font-mono text-xs text-[var(--color-text-muted)]">
            generated from your listening history
          </p>
        </div>
        <Link
          href="/dashboard"
          className="rounded-full border border-[var(--color-border)] px-4 py-1.5 font-mono text-xs uppercase tracking-widest text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-text)]"
        >
          ← dashboard
        </Link>
      </header>

      {playlists.length === 0 ? (
        <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-8 text-center">
          <p className="text-sm text-[var(--color-text-muted)]">
            No playlists yet — they&rsquo;re built during the nightly compute once you&rsquo;ve
            imported enough history.
          </p>
        </section>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {playlists.map((p) => (
            <Link
              key={p.id}
              href={`/playlists/${p.id}`}
              className="group flex flex-col gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-5 transition-colors hover:border-[var(--color-accent)]"
            >
              <h2 className="text-base font-medium text-[var(--color-text)] group-hover:text-[var(--color-accent)]">
                {p.title}
              </h2>
              <p className="flex-1 text-sm text-[var(--color-text-muted)]">{p.description}</p>
              <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
                <span>{p._count.items} tracks</span>
                <span>generated {fmtDate(p.generatedAt)}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
