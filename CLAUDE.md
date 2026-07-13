# CLAUDE.md

Guidance for Claude Code when working in the deepcut repo.

## What this is

Deepcut builds your **tastegraph** — a weighted map of a user's music taste computed from their
real Spotify listening history (GDPR export backfill + live 30-min polling). See README.md for
the product story, docs/ROADMAP.md for phases, **TODO.md for exactly what's next**.

## Hard rules

- **No AI attribution in git**: no `Co-Authored-By: Claude` trailers, no "Generated with Claude Code"
  in commits or PRs. Ben's explicit preference.
- **Read docs/SPOTIFY-CONSTRAINTS.md before touching anything Spotify-facing.** Non-negotiables:
  never feed Spotify Content into ML/AI models, never mirror catalog data, taste computation stays
  deterministic scoring over the user's own data. Dev mode = 5 users max; audio-features and
  recommendations endpoints do not exist for this app.
- Docker images are `node:22-slim` — do NOT switch to alpine (Prisma engine / OpenSSL mismatch).

## Commands

```bash
npm run dev                                   # Next.js on localhost:3000 (needs dev db)
docker compose -f docker-compose.dev.yml up -d  # dev Postgres only (port 5432)
npm run worker                                # cron worker (poll + nightly tastegraph)
npm run build && npx tsc --noEmit             # verify before pushing
npx prisma migrate dev                        # new migration (dev db running)
```

## Deploy

Server: Debian box, `ssh ben@192.168.68.69`, app at `/home/ben/deepcut`, host port 3020.

```bash
ssh ben@192.168.68.69 'cd /home/ben/deepcut && git pull && docker compose up -d --build'
```

Server `.env` is NOT in git (secrets generated on-server; Spotify creds may still be REPLACE_ME —
see TODO.md). Landing page deploys separately: any push touching `site/**` triggers the Pages
workflow → https://ben4mn.github.io/deepcut/

## Architecture in one breath

Next.js 15 App Router + Prisma/Postgres. `auth.ts` = Auth.js v5 Spotify OAuth (PKCE, AES-256-GCM
token storage via lib/crypto.ts). `worker/` polls recently-played every 30 min (cursor in
SpotifyAccount.pollCursor) and computes TasteSnapshots nightly at 04:10. `lib/import/` parses the
GDPR export ZIP (the only source of msPlayed/skipped). `lib/tastegraph/` = deterministic windowed
scoring (ALL/R30/R90/R180/R360/Y####). `lib/ingest.ts` = shared upsertTrack/insertPlay with
cross-source dedupe (unique [userId,trackId,playedAt] + ±120s poll-vs-export window).
Full detail: docs/ARCHITECTURE.md.
