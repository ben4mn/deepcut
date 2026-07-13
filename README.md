# Deepcut

**Deepcut builds your tastegraph — a weighted map of your music taste from your real listening history.**

Most "your top songs" features run on a snapshot: whatever Spotify's algorithm decided to surface this week. Deepcut instead ingests your actual play history — starting from your GDPR extended streaming export and then staying current via live polling — and computes a deterministic, weighted graph of what you actually listen to, how often, how completely, and how that's shifted over time.

Where this is going: auto-generated playlists (Top Songs of All Time, era playlists, mood playlists), taste prediction, friend-to-friend taste analytics, and eventually an AI-friendly layer on top of Spotify — a user-scoped MCP server that exposes your derived taste profile so an AI assistant gets real context about your music taste, not just play/pause control.

This is a private project for Ben and friends. Spotify's developer platform caps unverified apps at 5 authorized users, so it stays small by necessity — see [Constraints](#constraints) below.

## Status

**Phase 0 — Foundation.** Repo scaffolding, OAuth, the poller, the export importer, tastegraph v0, and a first dashboard are being built. Nothing is deployed yet. See [docs/ROADMAP.md](docs/ROADMAP.md) for what's next.

## How it works

1. **Sign in with Spotify.** OAuth (PKCE) grants Deepcut read access to your recently-played tracks and top items, plus permission to write playlists later.
2. **Upload your extended streaming history export.** Request it from [spotify.com/account/privacy](https://www.spotify.com/account/privacy) — it's your entire lifetime listening record with play-percent and skip data that the API will never give you. This seeds your tastegraph with real history instead of a cold start.
3. **Your tastegraph builds itself and keeps growing.** A background worker polls your recently-played tracks every 30 minutes and recomputes your taste snapshots nightly, so the graph stays current without you doing anything.

## Architecture

```
                     ┌──────────────────┐
   Spotify OAuth ───▶│   Next.js app     │◀─── you (browser)
   (Auth.js v5)       │  (port 3020)      │
                     │  - dashboard      │
                     │  - export upload  │
                     │  - API routes     │
                     └────────┬──────────┘
                              │
                              ▼
                     ┌──────────────────┐
                     │   PostgreSQL      │◀───┐
                     │  (Prisma schema)  │    │
                     └────────┬──────────┘    │
                              ▲                │
                              │                │
                     ┌────────┴──────────┐    │
                     │   worker (tsx)    │────┘
                     │  - poll every 30m │
                     │  - nightly compute│
                     └───────────────────┘
```

Full breakdown — data flow, dedupe strategy, token encryption, tastegraph computation — in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Local dev setup

```bash
cp .env.example .env
```

Fill in `.env`:

- `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` — create an app at [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard), add redirect URI `http://localhost:3000/api/auth/callback/spotify`.
- `AUTH_SECRET` — `openssl rand -base64 32`
- `TOKEN_ENCRYPTION_KEY` — `openssl rand -hex 32` (AES-256-GCM key used to encrypt stored Spotify tokens)
- `DATABASE_URL` — leave as-is for the default Docker Compose Postgres

Then:

```bash
docker compose -f docker-compose.dev.yml up -d   # Postgres
npm install
npx prisma migrate dev
npm run dev      # Next.js app on :3000
npm run worker   # cron worker (poller + nightly compute), separate terminal
```

## Constraints

Deepcut runs against Spotify's Web API in **Development Mode**, which caps the app at **5 authorized users** and requires the owner (Ben) to hold an active Premium subscription. Several endpoints Deepcut would like to use (audio features, recommendations, related artists) were deprecated for new apps in November 2024 and are permanently unavailable. There is no hobbyist path to more users — Extended Quota Mode requires a registered business with 250k+ monthly active users.

Full detail, sources, and Deepcut's ToS posture (why taste profiles are computed from user-provided exports rather than scraped or fed into ML models) in [docs/SPOTIFY-CONSTRAINTS.md](docs/SPOTIFY-CONSTRAINTS.md).

## Roadmap

Phase 0 (this repo) → Phase 1 taste engine v1 → Phase 2 playlists written back to Spotify → Phase 3 friend analytics + scrobble-based scaling → Phase 4 MCP / AI DJ layer → Phase 5 public (maybe, pending a business entity or a scrobble-first pivot). Full plan in [docs/ROADMAP.md](docs/ROADMAP.md).

## License

None yet. All rights reserved — this is a private project, not (yet) open source.
