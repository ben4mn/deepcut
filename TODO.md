# Deepcut TODO

Current state: Phase 0 (foundation) is built and deployed. Repo public, landing live at
https://ben4mn.github.io/deepcut/, stack running on the Debian box at http://192.168.68.69:3020.

## Blocked on Ben (do these first)

- [ ] Create the Spotify app at https://developer.spotify.com/dashboard
  - Redirect URIs: `http://localhost:3000/api/auth/callback/spotify` and `http://192.168.68.69:3020/api/auth/callback/spotify`
  - Put client ID/secret into local `.env` AND `/home/ben/deepcut/.env` on the server (currently `REPLACE_ME`), then `docker compose up -d` to restart with new env
  - Reminder: dev mode = max 5 allowlisted users, owner must keep Premium
- [ ] Request your data at https://www.spotify.com/account/privacy — check **Extended streaming history**, confirm the email, wait 1–5 days, upload the ZIP on the dashboard
- [ ] First real login → verify plays appear after the next 30-min poll
- [ ] Decide public hostname (e.g. `deepcut.4mn.org`) → wire Cloudflare tunnel, update server `AUTH_URL` + Spotify redirect URI to match

## Next up (Phase 1 — taste engine v1)

> Full blueprint: **docs/TASTEGRAPH-DESIGN.md** — event value model, three-clock decay,
> calibration layer, 30+ derived signals with weights, the playlist portfolio, and the
> 10-mechanism prediction engine. Build order is §9 of that doc.

### Built 2026-07-12 (v1 core, verified with synthetic fixture)

- [x] Event value model + three clocks (Pulse/Season/Core) — `lib/tastegraph/eventValue.ts`, `lifecycle.ts`
- [x] Calibration layer (ListenerProfile) — `lib/tastegraph/calibration.ts`
- [x] Session reconstruction (30-min gap) — `lib/tastegraph/sessionize.ts`
- [x] TrackLifecycle: quadrants, burnout/cooldown, resurrection, curve shapes, honeymoon slope, heartbeat CV
- [x] Play context fields (offline/incognito/platform) through importer
- [x] Playlist engine (12 kinds incl. One-Artist Era flagship) — `lib/playlists/`, `/playlists` pages
- [x] Dashboard v1: quadrant map, Desert-Island Core, listener meters
- [x] Synthetic fixture rig — `npm run fixture && npm run seed:demo` (dev db is on **localhost:5433**)

### Tuning debt (fixture showed these)

- [ ] Curve-shape thresholds: only 1/5 planted comets and 3/5 growers classified (short-lifespan
      tracks confuse peak-position logic); revisit `curveShape` rules in `lifecycle.ts`
- [ ] Burnout detection caught 3/5 planted burns — sliding 28d peak vs fixture's 90d peak window
- [ ] FULL_SEND produced 0 rows on fixture (zero-early-skip + ≥0.98 completion too strict vs
      realistic jitter) — consider ≥0.95 completion or allow 1 early skip
- [ ] Wallpaper-listening dampener (DESIGN §1) not yet implemented


- [ ] Genre enrichment pipeline: MusicBrainz (canonical genres, ~1 req/s) + Last.fm tags, keyed off track/artist; populates `Artist.genres`, unlocks GENRE snapshots (currently TODO in `lib/tastegraph/compute.ts`)
- [ ] Skip-signal: negative weighting from `skipped` + low `msPlayed` (data already stored, excluded from scores)
- [ ] Recency decay functions on scores ("split relationship into time" from the original design notes)
- [ ] Taste-over-time view: snapshot history per window, era detection (year windows already computed)
- [ ] `/me/top/*` cold-start prior for brand-new users with no export yet

## Phase 2 — playlists

- [ ] Playlist writer: `POST /me/playlists` + `/playlists/{id}/items` (new Feb 2026 paths)
- [ ] "Top Songs of All Time" auto-playlist with refresh schedule
- [ ] Era playlists (per year window), first mood playlists (AcousticBrainz CC0 dump for pre-2022 audio features)

## Phase 3 — friends / scale

- [ ] Export-only mode (upload ZIP without Spotify OAuth) — sidesteps the 5-user cap for analytics-only friends
- [ ] Last.fm / ListenBrainz connect as live-tracking alternative beyond 5 users
- [ ] Taste-compatibility comparisons between users

## Phase 4 — MCP / AI DJ

- [ ] User-scoped MCP server exposing the derived tastegraph (never raw Spotify Content — see docs/SPOTIFY-CONSTRAINTS.md)
- [ ] Playback tools (Premium users) + "how do you feel" mood radio

## Housekeeping

- [ ] Optionally scrub Claude attribution trailers from the first 5 commit messages (rewrite + force-push + server reset) — Ben's call
- [ ] Stronger Postgres password on the server (db is compose-internal only, low urgency)
- [ ] Landing page accent (#c8ff4d green) vs app accent (#ff7a45 coral) — unify eventually
