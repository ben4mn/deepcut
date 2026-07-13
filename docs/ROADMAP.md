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

> Full blueprint with formulas, weights, and rationale: **[TASTEGRAPH-DESIGN.md](./TASTEGRAPH-DESIGN.md)**. Build order is its §9.

- **Event value model** (DESIGN §1): plays scored by how they started (backbtn 2.0 / clickrow 1.5 / trackdone 1.0), how they ended (early fwdbtn = −0.8, negative), completion^0.7, context bonuses (session-starter +0.25, offline +0.15, sequenced album +0.10); loop caps + wallpaper-listening dampener
- **Three-clock decay** (§2): Pulse (14d half-life), Season (90d), Core (730d with a 0.2 floor — identity never decays to zero)
- **Calibration layer** (§6.1, compute first): Restlessness Quotient, Decision Density, Shuffle Surrender, Cold-Open Tolerance, Silence Signature — per-listener normalizers so all other weights stay fair across eras and users
- **Session reconstruction** (30-min gap rule) → sequence signals (§6.2): Escape-Velocity Destination (+2.5), Anthem (+2.4), Palate Cleanser, Ouroboros, The Closer, Bridge Score, Flow Induction
- **Curve-shape signals** (§6.3): Comet/Star/Sleeper, The Standard, Half-Life of Obsession, Heartbeat Regularity, Honeymoon Slope
- **Identity signals** (§6.4–6.6): Desert-Island Core (+3.0), Security Blanket, Incognito-to-Canon, Speaker Test, Persona Divergence, Conviction Under Friction, Conspicuous Avoidance (−2.5), Sacred Album
- **Intensity × Durability quadrant map** (§3): All-Timers / Current Obsessions / Sleepers / Phases
- **Burnout & resurrection lifecycle** (§4): wearout ratio, 90-day cooldowns, resurrection eligibility
- Genre enrichment via MusicBrainz + Last.fm tags → unlocks §6.7 tier: Signature Deep Cut (the namesake metric), Superfan Percentile, Catalog Completionism
- Taste-over-time views (era double-keying: calendar year + account-age year)

## Phase 2 — Playlists

> Portfolio with selection rules, refresh cadences, and wow-stats: **[TASTEGRAPH-DESIGN.md](./TASTEGRAPH-DESIGN.md) §7**.

- **Flagships**: Your One-Artist Era (auto-detected obsession chapters), Deliberate / Background Noise (paired reveal — chosen taste vs algorithm-fed), The Soundtrack to a Bad Week (opt-in, ships last)
- **First wave (pure timestamp math)**: Top Songs of All Time, Heavy Rotation, Full Send, On Repeat One Night Only, Gateway Drugs, This Week Every Year, Comeback Kids, Resurrection Machine, One-Hit Wonder (By You), New Blood, On the Way Out
- **Behavioral mirrors**: Almost, The First 30 Seconds, Cold Open, The Perfect Sequence, 2:47 AM, Songs of Summer, New Year Same You, The Commute, The 11-Minute Songs, The 4-Star Section, Anniversary of a Discovery
- Written back to the user's Spotify account with scheduled worker refresh; burnout guard on all; incognito plays excluded from anything shareable
- Mood playlists via AcousticBrainz CC0 dump (pre-2022 coverage)

## Phase 2.5 — Prediction engine

> Full spec: **[TASTEGRAPH-DESIGN.md](./TASTEGRAPH-DESIGN.md) §8** — ten deterministic mechanisms over open data, ToS-clean by construction.

- MVP: M1 Deep Cuts of Loved Artists (MusicBrainz discography, 22–30% expected hit rate) → "Predicted for You" weekly 30
- Then: ListenBrainz + Last.fm CF arms, producer/label graph hops, taste-trajectory extrapolation, scene adjacency
- Per-user Thompson-sampling bandit over mechanisms (reward = user's own plays; weekly decay for taste drift; 20% exploration floor)
- Accuracy dashboard: 30-day hit rate with Wilson interval, per-mechanism leaderboard, random-control lift, calibration curve

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
