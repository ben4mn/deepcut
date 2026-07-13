# Roadmap

## Phase 0 — Foundation (this repo)

- Repo scaffolding, docs, landing page
- Spotify OAuth (Auth.js v5, PKCE, refresh rotation, encrypted token storage)
- Poller worker (recently-played, 30-min cadence)
- Export importer (GDPR extended streaming history ZIP upload + parse)
- Tastegraph v0 (play counts, play-percent averages, relationship counts, deterministic score — see [ARCHITECTURE.md](./ARCHITECTURE.md))
- Dashboard v0 (view your top tracks/artists/genres by window)
- Deploy (Debian home server, Docker Compose, Cloudflare tunnel)

## Phase 1 — Taste engine v1

- Full weighted signal set beyond v0's baseline (tune the score formula against real listening history instead of placeholder weights)
- Decay functions — recent plays weighted higher than old ones within a window, not just a hard rolling cutoff
- Genre enrichment via MusicBrainz + Last.fm tags (Spotify's own genre/audio-feature endpoints are deprecated for new apps — see [SPOTIFY-CONSTRAINTS.md](./SPOTIFY-CONSTRAINTS.md))
- Taste-over-time views — how your top artists/genres have shifted year to year

## Phase 2 — Playlists

- "Top Songs of All Time" and other auto-generated playlists written back to the user's Spotify account
- Era playlists (taste snapshots by year/period)
- Mood playlists, using AcousticBrainz's frozen CC0 mood/BPM/key dataset (pre-2022 coverage only) rather than Spotify's deprecated audio-features endpoint
- Scheduled refresh of generated playlists (worker-driven, same cadence pattern as polling)

## Phase 3 — Friends

- Shared analytics between connected users (who listens to what, taste overlap)
- Taste compatibility scoring
- Last.fm / ListenBrainz connect as an opt-in scrobble source — the only realistic path to scale past Spotify's 5-user dev-mode cap, since it doesn't require every friend to be individually authorized on the Spotify app

## Phase 4 — MCP / AI DJ

- User-scoped MCP server exposing the *derived* taste profile (not raw Spotify catalog content) plus playback tools, so an AI assistant gets real context about a user's music taste
- "How do you feel" mood radio — an interruptible, conversational playback mode
- Explicitly a ToS gray area (see [SPOTIFY-CONSTRAINTS.md](./SPOTIFY-CONSTRAINTS.md) — Rule 13/14 territory even when only derived data is exposed); stays local-first and user-scoped rather than a shared service, and stays deprioritized/reevaluated if Spotify's enforcement posture hardens further

## Phase 5 — Public (maybe)

- Blocked on either: registering a business entity and qualifying for Spotify's Extended Quota Mode (250k+ MAU requirement makes this unrealistic for a hobby project), or a pivot to a scrobble-first architecture (Last.fm/ListenBrainz as the primary ingestion path instead of the Spotify API) that sidesteps the dev-mode user cap entirely
- Not committed to; revisit once Phase 3 proves out the scrobble path

## Non-goals for now

- Mobile app
- Public signup / self-serve onboarding
- ML models trained on Spotify data (deterministic weighted scoring only — see [SPOTIFY-CONSTRAINTS.md](./SPOTIFY-CONSTRAINTS.md) for why this is a hard constraint, not just a style preference)
