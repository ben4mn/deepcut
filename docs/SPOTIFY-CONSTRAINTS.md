# Spotify Platform Constraints

Reference doc so future work on Deepcut never has to rediscover this from scratch. Verified **July 2026** against Spotify's own developer documentation, blog, and terms. Re-verify before making any decision that depends on a number or date below — Spotify has changed these terms multiple times in the last two years and there's no reason to assume it stops.

## Access tiers

### Development Mode (what Deepcut runs in)

- Maximum **5 authorized users** per app (this was 25 until a February 2026 policy change dropped it to 5).
- **1 Client ID per developer** account.
- The app owner must hold an **active Spotify Premium** subscription — the app doesn't function at all without it.
- Sources: `developer.spotify.com/documentation/web-api/concepts/quota-modes`, `developer.spotify.com/blog/2026-02-06-update-on-developer-access-and-platform-security`, and Spotify's February 2026 migration guide for existing apps.

### Extended Quota Mode

- Requires a **registered business** — not available to individual/hobbyist developers regardless of usage.
- Requires **≥250,000 monthly active users**, a threshold in effect since May 2025.
- Source: `developer.spotify.com/blog/2025-04-15-updating-the-criteria-for-web-api-extended-access`.
- **There is no path from Development Mode to more than 5 users without both of the above.** This is the hard ceiling that shapes Phase 3 (scrobble services instead of adding more Spotify-authorized users) and Phase 5 (public launch is blocked on this).

## Endpoint deprecations

### November 27, 2024 — permanent, for all new apps, never reversed

- `audio-features`
- `audio-analysis`
- `recommendations`
- `related-artists`
- Featured / category / algorithmic playlists
- 30-second preview URLs

Source: `developer.spotify.com/blog/2024-11-27-changes-to-the-web-api`. This is why Deepcut can't lean on Spotify's own audio features for mood/tempo signal — see the [enrichment alternatives](#enrichment-alternatives) table below.

### February 2026 — removed ~22 additional endpoints from Development Mode

- Batch-get endpoints
- Browse endpoints
- Other users' profiles and playlists
- Artist top-tracks
- Search `limit` parameter cut to a max of 10
- `popularity`, `available_markets`, and `followers` fields dropped from responses

Source: Spotify's February 2026 changelog.

## What still works (as used by Deepcut)

- **`GET /me/player/recently-played`** — last ~50 plays only, paginated via `before`/`after` unix-ms cursors, returns the full track object plus `played_at` and `context`. **Does not return skip or ms-played data** — that's only in the GDPR export. This is the entire poller's API surface.
- **`GET /me/top/artists`, `GET /me/top/tracks`** — `short_term` (~4 weeks), `medium_term` (~6 months), `long_term` (~1 year). Used as the cold-start prior only, per [ARCHITECTURE.md](./ARCHITECTURE.md).
- **Playlist writes** — `POST /me/playlists` (new path as of February 2026; the old path was retired), `POST` / `PUT` / `DELETE /playlists/{id}/items` (replaces the old `/tracks` path). These work in Development Mode and **do not require the target user to have Premium** — only playback control and the Web Playback SDK require Premium per user. Relevant to Phase 2 (playlist generation).
- **Rate limits** — a rolling 30-second window; Spotify does not publish the numeric ceiling. Expect `429` with a `Retry-After` header and back off accordingly.

## GDPR export

Requested at `spotify.com/account/privacy` → request → confirm via email → ZIP delivered by email. Two variants, and the difference matters a lot for Deepcut:

| | "Account data" | "Extended streaming history" |
|---|---|---|
| Turnaround | ~5 days | Up to 30 days, usually 1–5 |
| Coverage | past year only | **lifetime** |
| Files | `StreamingHistory*.json` | `Streaming_History_Audio_*.json` |
| Fields | `endTime`, `artistName`, `trackName`, `msPlayed` | 21 fields, see below |

**Extended streaming history is what Deepcut asks users to upload** — it's the only source of lifetime history and the only source of skip/completion signal. Its fields include: `ts` (end-of-stream timestamp), `ms_played`, `spotify_track_uri`, `master_metadata_track_name`, `master_metadata_album_artist_name`, `master_metadata_album_album_name`, `reason_start`, `reason_end` (`trackdone`, `fwdbtn`, `clickrow`, etc.), `shuffle`, `skipped`, `offline`, `incognito_mode`, `platform`, `conn_country`, `ip_addr`. Deepcut only persists the listening-relevant fields (track identity, timestamps, ms_played, skip/shuffle/reason flags) — see [ARCHITECTURE.md](./ARCHITECTURE.md#1-gdpr-extended-streaming-history-export-primary-corpus) for exactly what gets written and where fields like `ip_addr` are simply never ingested.

## Terms of Service posture

Governed by Spotify's **Developer Terms v10** and the accompanying Developer Policy, effective **2025-05-15** (`developer.spotify.com/terms`, `developer.spotify.com/policy`). The rules that actually constrain Deepcut's design:

- **Rule 14** — bans training on, or "otherwise ingesting," Spotify Content into ML/AI models.
- **Rule 13** — bans analyzing Spotify Content into user profiles or derived listenership metrics.
- **Rule 11** — bans replicating core Spotify experiences (e.g. recommendations) without written permission.
- Caching is restricted to metadata/cover art that is "temporary… strictly necessary" — no persistent catalog mirroring.
- No scraping, no building a catalog database from Spotify Content.

### Where Deepcut sits relative to these rules

This is a genuinely gray area and worth stating plainly rather than glossing over:

- Taste profiles are computed from the user's **own GDPR export** (data Spotify already gave that specific user, uploaded by them) via **deterministic scoring** — not a trained model, and not built by scraping Spotify's catalog. This is the reasoning behind "no ML" as a hard architectural constraint, not a style choice (see [ROADMAP.md](./ROADMAP.md) non-goals).
- Each user's tastegraph is shown **only to that user** (friend analytics in Phase 3 is aggregate/comparative, not a redistribution of one user's raw listening data to another without their participation).
- The live Spotify API surface is kept intentionally narrow: login, `recently-played`, and playlist-write. No catalog browsing, no batch metadata mirroring, no building a searchable Spotify content database.
- **Rule 13 ("derived listenership metrics") is the one Deepcut brushes closest to** — the entire point of the product is a derived taste profile. The mitigating position is that the profile is derived from the user's own data, for that user's own use, not aggregated across users into something resembling a Spotify-competing analytics product. This has not been tested against Spotify's enforcement in practice.
- **Phase 4 (MCP layer)** feeds an AI assistant the *derived* profile — never raw Spotify Content, never track audio, never catalog data — but exposing *any* Spotify-derived signal through a third-party AI interface is still squarely in gray-zone territory. The mitigation is that it stays user-scoped and local-first (each user runs/authorizes their own instance; nothing is pooled or served multi-tenant), not because that makes it compliant, but because it limits blast radius if Spotify decides otherwise.

Bottom line: this posture reduces risk, it doesn't eliminate it. Revisit this section if Spotify updates its terms or if Deepcut's user count/visibility grows.

## Ecosystem notes

- Spotify shipped an **official Spotify↔Claude connector** in April 2026 via a direct partnership — this is not a general developer MCP program and doesn't change anything about third-party MCP access.
- Community-built Spotify MCP servers exist but all inherit the same Development Mode caps described above — they don't unlock anything Deepcut doesn't already have.
- Spotify issued a **cease-and-desist against third-party tooling in October 2025**. Platform risk here is real, not theoretical — Deepcut's local-first, user-scoped, own-data posture is a mitigation, not a guarantee.

## Enrichment alternatives

Since Spotify's own audio-features/recommendations/related-artists endpoints are permanently gone for new apps, enrichment has to come from elsewhere:

| Source | Provides | Status |
|---|---|---|
| MusicBrainz | Genres | ~1 req/s rate limit; viable |
| Last.fm API | Tags, scrobbles | Viable |
| ListenBrainz | Scrobbles, similarity | Viable; also the Phase 3 scaling path |
| AcousticBrainz | Mood, BPM, key | **Frozen February 2022** — no new data, but a CC0 dump covering ~7.5M recordings is available and usable as-is |
| Essentia | Self-hosted audio analysis | AGPL-licensed; requires running your own analysis, not a hosted API |
| ReccoBeats | Audio-feature-like data | Provenance unverified — best-effort only, don't depend on it |
| Every Noise (at Once) | Genre space mapping | **Frozen November 2023** |
| Deezer | Catalog metadata | Registration for new API access is closed |
