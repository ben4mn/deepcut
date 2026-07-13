import { signIn } from "@/lib/auth";

export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-6 text-center">
      <h1 className="text-5xl font-semibold tracking-tight lowercase text-[var(--color-text)]">
        deepcut
      </h1>
      <p className="max-w-md text-balance text-[var(--color-text-muted)]">
        Deepcut builds your tastegraph — a weighted map of your music taste
        from your real listening history.
      </p>
      <form
        action={async () => {
          "use server";
          await signIn("spotify", { redirectTo: "/dashboard" });
        }}
      >
        <button
          type="submit"
          className="mt-4 rounded-full bg-[var(--color-accent)] px-6 py-3 text-sm font-medium text-black transition-colors hover:bg-[var(--color-accent-strong)]"
        >
          Sign in with Spotify
        </button>
      </form>
    </main>
  );
}
