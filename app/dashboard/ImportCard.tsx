"use client";

import { useState } from "react";

export interface ImportRow {
  id: string;
  filename: string;
  status: string;
  rowsTotal: number;
  rowsImported: number;
  rowsSkipped: number;
  createdAt: string;
}

type UploadState = "idle" | "uploading" | "done" | "error";

const STATUS_COLORS: Record<string, string> = {
  done: "text-emerald-400",
  processing: "text-[var(--color-accent)]",
  pending: "text-[var(--color-text-muted)]",
  error: "text-red-400",
};

export default function ImportCard({
  initialImports,
}: {
  initialImports: ImportRow[];
}) {
  const [file, setFile] = useState<File | null>(null);
  const [state, setState] = useState<UploadState>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [imports, setImports] = useState<ImportRow[]>(initialImports);

  async function refreshImports() {
    try {
      const res = await fetch("/api/import");
      if (!res.ok) return;
      const data = (await res.json()) as { imports: ImportRow[] };
      setImports(data.imports ?? []);
    } catch {
      /* non-fatal */
    }
  }

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    if (!file || state === "uploading") return;

    setState("uploading");
    setMessage(`Uploading & processing ${file.name}…`);

    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/import", { method: "POST", body });
      const data = await res.json();

      if (!res.ok) {
        setState("error");
        setMessage(data?.error ?? `Upload failed (${res.status})`);
        return;
      }

      if (data.status === "error") {
        setState("error");
        setMessage(`Import errored: ${data.error ?? "unknown error"}`);
      } else {
        setState("done");
        setMessage(
          `Imported ${data.rowsImported} of ${data.rowsTotal} plays (${data.rowsSkipped} skipped).`
        );
      }
      setFile(null);
      await refreshImports();
    } catch (err) {
      setState("error");
      setMessage(err instanceof Error ? err.message : "Upload failed");
    }
  }

  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-5">
      <h2 className="font-mono text-xs uppercase tracking-widest text-[var(--color-text-muted)]">
        Import your history
      </h2>

      <form onSubmit={handleUpload} className="mt-4 flex flex-col gap-3">
        <input
          type="file"
          accept=".zip,application/zip"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setState("idle");
            setMessage(null);
          }}
          className="block w-full cursor-pointer text-sm text-[var(--color-text-muted)] file:mr-3 file:cursor-pointer file:rounded-full file:border-0 file:bg-[var(--color-border)] file:px-4 file:py-2 file:text-sm file:font-medium file:text-[var(--color-text)] hover:file:bg-[var(--color-accent)] hover:file:text-black"
        />
        <button
          type="submit"
          disabled={!file || state === "uploading"}
          className="self-start rounded-full bg-[var(--color-accent)] px-5 py-2 text-sm font-medium text-black transition-colors hover:bg-[var(--color-accent-strong)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {state === "uploading" ? "Processing…" : "Upload ZIP"}
        </button>

        {message && (
          <p
            className={`text-sm ${
              state === "error"
                ? "text-red-400"
                : state === "done"
                  ? "text-emerald-400"
                  : "text-[var(--color-text-muted)]"
            }`}
          >
            {message}
          </p>
        )}
      </form>

      <details className="mt-5 text-sm text-[var(--color-text-muted)]">
        <summary className="cursor-pointer select-none font-mono text-xs uppercase tracking-widest">
          How to get your Spotify history
        </summary>
        <ol className="mt-3 list-decimal space-y-1 pl-5">
          <li>
            Go to{" "}
            <a
              href="https://www.spotify.com/account/privacy/"
              target="_blank"
              rel="noreferrer"
              className="text-[var(--color-accent)] underline"
            >
              spotify.com/account/privacy
            </a>
            .
          </li>
          <li>
            Under &ldquo;Download your data&rdquo;, select{" "}
            <strong className="text-[var(--color-text)]">
              Extended streaming history
            </strong>{" "}
            (not the basic account data).
          </li>
          <li>Request it and confirm via the email Spotify sends you.</li>
          <li>
            Spotify emails a download link when it&rsquo;s ready — typically 1–5
            days later.
          </li>
          <li>Download the ZIP and upload it here.</li>
        </ol>
      </details>

      {imports.length > 0 && (
        <div className="mt-5">
          <h3 className="font-mono text-xs uppercase tracking-widest text-[var(--color-text-muted)]">
            Import history
          </h3>
          <ul className="mt-2 divide-y divide-[var(--color-border)]">
            {imports.map((imp) => (
              <li
                key={imp.id}
                className="flex items-center justify-between gap-3 py-2 text-sm"
              >
                <span className="truncate text-[var(--color-text)]">
                  {imp.filename}
                </span>
                <span className="flex shrink-0 items-center gap-3">
                  <span className="text-[var(--color-text-muted)]">
                    {imp.rowsImported}/{imp.rowsTotal}
                  </span>
                  <span
                    className={
                      STATUS_COLORS[imp.status] ??
                      "text-[var(--color-text-muted)]"
                    }
                  >
                    {imp.status}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
