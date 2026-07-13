# Tastegraph Design — Signals, Weights, Playlists, Prediction

The full design for Deepcut's taste engine: how raw play events become affinity scores, which
derived signals we compute, the playlist portfolio, and how prediction works without Spotify's
dead recommendation APIs. This is the blueprint for Phases 1–2 (and seeds for 3–4).

Everything here is deterministic scoring over the user's own data — no ML training on Spotify
Content (see SPOTIFY-CONSTRAINTS.md).

---

## 1. The event value model

Every play event earns a value from *how it started*, *how it ended*, and *how much was heard* —
not just that it happened. A play you sought out and finished is worth ~3× a passive autoplay;
an early skip is actively negative.

```
EventValue = StartWeight × EndFactor × Completion^0.7 × (1 + Σ ContextBonuses)
```

### Start weights (intentionality)

| reason_start | weight | reading |
|---|---|---|
| backbtn (immediate replay) | 2.0 | strongest single signal in the dataset — you needed to hear it again |
| clickrow / search / playbtn | 1.5 | deliberate choice |
| trackdone (autoplay chain) | 1.0 | passive flow — baseline |
| appload / remote / unknown | 0.9 | ambient/incidental |

### End factors (how it ended)

| reason_end + position | factor | reading |
|---|---|---|
| trackdone | 1.0 | consumed |
| endplay / logout | 0.9 | session ended, not a judgment |
| fwdbtn at >80% | 0.8 | effectively consumed, mild impatience |
| fwdbtn at 25–80% | 0.1 | lukewarm |
| fwdbtn at <25% (and <60s) | **−0.8** | active rejection — negative value |
| unexpected-exit | 0.0 | discard, not a signal |

Completion = min(ms_played/duration, 1), raised to 0.7 so partial listens aren't linearly cheap
(hearing 50% of a song is worth ~62% of a full listen, not 50%).

### Context bonuses (additive, then applied as a multiplier)

| context | bonus | why |
|---|---|---|
| session-starter (first intentional play after ≥30 min gap) | +0.25 | what you reach for first is top-of-mind taste |
| offline play | +0.15 | you committed storage to it |
| sequenced album session (shuffle=false, ≥3 album tracks in order) | +0.10 | album-as-work respect |
| incognito | +0.00 | scores normally, but flagged — feeds Guilty Pleasures, excluded from shared/friend views by default |

### Noise dampeners

- **Loop cap**: a track's contribution is capped at 10 EventValue per day (obsessive looping counts, but sublinearly).
- **Wallpaper detection**: uninterrupted trackdone chains ≥ 25 tracks on speaker/web platforms with zero interactions → all events in the chain ×0.7 (music-as-wallpaper ≠ taste).

## 2. Three clocks — the decay architecture

One decay rate can't serve both "what am I into right now" and "who am I musically."
Every track/artist affinity is maintained on three parallel clocks:

| clock | half-life | floor | answers |
|---|---|---|---|
| **Pulse** | 14 days | 0 | what's hot for you *this week* |
| **Season** | 90 days | 0 | current rotation, mood of the quarter |
| **Core** | 730 days | 0.2 × peak | musical identity — never fully decays; taste is cumulative |

`Affinity_clock(track) = Σ EventValue(e) × 0.5^(age(e)/halflife)`

The Core floor matters: a song you played 300 times in 2016 and never since is still *yours* —
it decays to a durable remnant, not zero.

## 3. The two-axis taste map: Intensity × Durability

- **Intensity** = Season-clock affinity (percentile-ranked within the user's library)
- **Durability** = (distinct active quarters ÷ quarters since first play) × ln(1 + lifetime plays)

Every track lands in a quadrant, and the quadrants drive everything downstream:

| | high durability | low durability |
|---|---|---|
| **high intensity** | **All-Timers** — the canon | **Current Obsessions** — honeymoon phase |
| **low intensity** | **Sleepers** — old faithfuls, resurrection fuel | **Phases** — era-bound, time-capsule fuel |

## 4. Burnout & resurrection (the rotation lifecycle)

- **Wearout ratio** = (plays in trailing 28d) ÷ (peak trailing-28d play rate). Burned = ratio < 0.15 after ≥ 12 lifetime plays.
- Burned tracks get a **cooldown**: excluded from generated playlists for 90 days (protecting the user from us killing their favorites).
- **Resurrection-eligible** = Core affinity ≥ 70th percentile AND dormant ≥ 180 days AND not burned. These are the highest-delight recommendations that cost nothing.
- **Honeymoon slope** = d(Pulse)/dt over first 21 days after first play — steep slope predicts All-Timer conversion (track it; it's also the wow-stat "you fall for songs in ~N days").

## 5. Rollups: artist, genre, era

- **Artist** = Σ(top-10 track affinities) × (1 + 0.3 × breadth), breadth = normalized entropy of play
  distribution across that artist's tracks. Ten deep cuts beat one megahit on repeat — depth is taste.
- **Genre** (post-enrichment) = play-weighted mean of member-artist affinities, normalized against the
  user's overall listening so big genres don't auto-win.
- **Era** = every play double-keyed to (calendar year) and (user-age-of-account year) — powers
  time-capsule playlists and the taste-evolution timeline.
- Every score ships with `n_effective` (event count behind it). Dashboard hides anything below
  n=8; playlists weight by score × min(1, n/15) so thin data can't headline.

## 6. Derived signal library

Extends the v0 set (windowed counts, completion averages, relationship counts). Weights are on
the EventValue-adjusted affinity scale from §1.

### 6.1 The calibration layer (compute FIRST)

These are listener meta-traits, not track scores — they normalize everything else so a
completion from a patient 2014-you and a trigger-happy 2026-you are comparable:

| trait | computation | role |
|---|---|---|
| **Restlessness Quotient** | global skip rate + median ms before a fwdbtn | ×0.7–1.4 multiplier on all completion-based signals |
| **Decision Density** | manual events (clickrow/fwd/back) per listening hour | calibrates how much one intentional pick means for THIS user |
| **Shuffle Surrender** | share of passive-autoplay plays, tracked over time | down-weights affinity accrued during lean-back stretches |
| **Cold-Open Tolerance** | completion rate on first-ever algorithm-served plays | new tracks that survive an impatient listener get +1.0 |
| **Silence Signature** | hour×weekday cells with zero lifetime plays | plays landing in a dead zone get dampened (likely someone else / accident) |

### 6.2 Intent & sequence signals (session-graph mining)

| signal | computation | weight |
|---|---|---|
| **Escape-Velocity Destination** | tracks arrived at via fwdbtn that then complete far above baseline — songs you skip *toward* | **+2.5** (highest-intent event in the dataset) |
| **Anthem** | clickrow as first action after appload, then completed — the song you open the app *for* | +2.4 |
| **Palate Cleanser** | first completed track after a ≥3-skip storm — the trusted reset | +1.8 |
| **Ouroboros** | A→B→A immediate loops within a session | +1.5 to both tracks |
| **The Closer** | intentional final track before a ≥45min gap (trackdone, not logout) | +1.2 |
| **Bridge Score** | first-order Markov on shuffle=false chains; low-entropy outgoing row = ritual segue ("you always play X into Y") | +1.0 launcher, +0.5 successor |
| **Flow Induction** | average uninterrupted-run length a track triggers downstream | +1.3 |

### 6.3 Curve-shape signals (the shape of a relationship)

| signal | computation | weight |
|---|---|---|
| **Comet / Star / Sleeper** | skewness + peak position of lifetime weekly play histogram | Star +2.0, Sleeper (peak long after discovery — *chosen* love) +1.8, Comet +0.3 |
| **The Standard** | near-zero slope across ≥3 consecutive years, above-median volume | +2.2 — the user's invariants |
| **Half-Life of Obsession** | exponential fit to lengthening inter-play gaps per track | long half-life +2.0; days-scale −0.5 (novelty churn) |
| **Heartbeat Regularity** | coefficient of variation of inter-play intervals; low CV at μ≈7d = weekly ritual, μ≈1yr = anniversary track | +1.6 |
| **Honeymoon Slope** | d(Pulse)/dt in first 21 days — steep slope predicts All-Timer conversion | predictive feature + wow-stat ("you fall for songs in ~N days") |

### 6.4 Identity signals (the "it knows me" tier)

| signal | computation | weight |
|---|---|---|
| **Desert-Island Core** | smallest track set covering 50% of lifetime ms_played that also appears in every calendar year | **+3.0** — the flagship reveal |
| **Security Blanket** | dominant familiar tracks within the user's lowest-novelty sessions — music-as-comfort | +2.0 |
| **Incognito-to-Canon** | first K plays incognito, later ≥M public completed plays — the "you stopped hiding this" arc | +2.0 |
| **Context Loyalty** | (live polling) entropy of context URIs; user-owned-playlist-dominant = claimed | +1.7 vs +0.2 for radio-only |
| **Reach-Back Depth** | age of track (vs its first play) at each clickrow — nostalgia gradient; rising mean = living in your past | recalled-old-tracks +1.6 |
| **Binge Intensity** | mean completed plays per session-it-appears-in; >2 = looping | +1.4 per unit above 1 |

### 6.5 Context & authenticity signals

| signal | computation | weight |
|---|---|---|
| **The Speaker Test** | per-track skip rate on speaker/shared platforms vs private headphones — private-completed but speaker-skipped = private-only taste | private-consistent +1.5; performative-only −0.8 (tagged "social display") |
| **Persona Divergence** | JS-divergence between public-context and private-context artist distributions | headline stat: "your public taste is N% different from your real one" |
| **Conviction Under Friction** | completion offline minus completion online — devotion when alternatives were pre-chosen | +1.4 |

### 6.6 Negative space (anti-taste)

| signal | computation | weight |
|---|---|---|
| **Conspicuous Avoidance** | served ≥N times (autoplay/radio), always early-skipped — encountered and refused ≠ never met | **−2.5**, the strongest negative signal |
| **The Sacred Album** | ≥K album plays, ~100% shuffle=false, tracklist order — reverence via conspicuous non-shuffle | +1.8 album, +0.6 spread to tracks |

### 6.7 Post-enrichment tier (needs Last.fm/MusicBrainz popularity + catalog data)

- **Signature Deep Cut** — `personal_plays × log(1/global_popularity)` (TF-IDF over listener
  counts). The product's namesake metric and likely #1 reveal once enrichment lands. +2.5
- **Superfan Percentile** — your artist-share vs the global fan distribution: "top 2% listener
  of X." The most shareable stat in the product.
- **Catalog Completionism** — distinct tracks played ÷ artist catalog size; coverage, not volume.
- **The Skipped Hit** — globally-huge tracks you always refuse: contrarian identity flag that
  raises deep-cut weights elsewhere. −1.5

## 7. The playlist portfolio

Full concept bank below; every rule is computable from fields we actually have. Names are
library-ready. "Wow-stat" = the caption that makes it screenshot-worthy.

### Flagships (headline the product)

1. **Your One-Artist Era** — auto-detected obsession chapters. Scan 90-day windows for any artist
   exceeding 25% of total plays; generate "«Artist», Winter 2019" playlists from that window's
   tracks. Wow-stat: *"1 of every 4 songs you heard that winter was them."* Repeatable forever,
   robust signal, zero creep factor.
2. **Deliberate / Background Noise** (paired reveal) — the product thesis. *Deliberate*: tracks
   with ≥80% intentional starts (clickrow/search/session-opener), your taste with the algorithm
   stripped out. *Background Noise*: top-20% play count but ≥70% passive autoplay starts —
   "your #4 most-played song, and you never once chose it." Side-by-side: what you love vs.
   what you were fed. No other product can show this.
3. **The Soundtrack to a Bad Week** — anomaly weeks (play-volume z≥2 vs 90-day baseline, ≥50%
   plays 11pm–4am, top-5 tracks ≥40% of volume) become gentle, opt-in time capsules. The
   "how did it know" moment. Needs warm copy and an opt-in gate — emotional peak of the product.

### Core rotation (ship first — pure play-count + timestamp math)

| playlist | rule sketch | refresh | wow-stat |
|---|---|---|---|
| Top Songs of All Time | Core-clock score, burnout-guarded | monthly | the canon |
| Heavy Rotation | Pulse-clock top 50 | weekly | what you're on right now |
| Full Send | ≥15 plays, 0% skip rate, ≥98% completion | monthly | "247 plays. Zero skips." |
| On Repeat, One Night Only | ≥8 plays in 24h = ≥90% of lifetime plays | quarterly | "14 plays on Mar 3 2019, never again" |
| Gateway Drugs | earliest-played track per top-50 artist, chronological | monthly | your discovery timeline |
| This Week, Every Year | top tracks from this calendar week in each past year | weekly | rolling self-mirror |
| Comeback Kids | dormant ≥270d, current 30d rate > original peak | monthly | "back and bigger than 2021" |
| Resurrection Machine | Core ≥p70, dormant ≥180d, not burned | weekly | "remember this?" |
| One-Hit Wonder (By You) | one track = 100% of an artist's ≥25 plays | quarterly | the funny self-own |
| New Blood | first play ≤60d, positive Pulse slope, ≥5 plays | weekly | who you're becoming |
| On the Way Out | 30d affinity −50% vs 180d, still alive | weekly | last call before it fades |

### Behavioral mirrors & oddities

| playlist | rule sketch | note |
|---|---|---|
| Almost | ≥10 plays, mean completion 75–92%, fwdbtn clustered in final 20% | "you've never heard the last 15 seconds" |
| The First 30 Seconds | ≥40% of plays skipped <30s, yet ≥12 lifetime starts | the contradiction playlist |
| Cold Open | most frequent session-opener tracks (+ Last Call companion) | your warm-up ritual |
| The Perfect Sequence | session 2/3-gram mining, same order ≥10× | "these three, this order, 22 times" |
| 2:47 AM | circular-mean play hour in 1–4am band, low variance | title derived from user's actual peak minute |
| Songs of Summer | ≥75% of plays Jun–Aug across ≥2 years | seasonal self, provable |
| New Year, Same You | played in first 14 days of ≥3 Januaries | rituals you didn't know you had |
| The Commute | weekday 7–9am + mobile + offline envelope ≥60% | knows your life's rhythm |
| The 11-Minute Songs | duration ≥7min, completion ≥95%, ≥5 plays | attention-span badge |
| The 4-Star Section | p60–p85 affinity, near-flat monthly variance | the reliable middle, finally named |
| Anniversary of a Discovery | first-play N years ago this week → became top-15% | event-driven, notification-worthy |

### Gated concepts

- **Saved for Never** (library saves with ≤1 play since) — needs YourLibrary.json from the
  account-data export; add when we parse it.
- **Genre You Didn't Know You Had** — post genre-enrichment.
- **Friends tier** (Phase 3): **Before It Was Cool** (your first-play predates friend median by
  ≥90d — the flex with receipts), **Only You** (your top-20% tracks with zero friend plays),
  **The Group Chat Anthem** (maximize the *minimum* affinity across friends).
- Dropped: seek/scrub-position ideas ("Skip to the Good Part") — within-play seek telemetry
  doesn't exist in the export.

### Portfolio rules

- Every generated playlist gets a Deepcut-owned description with its wow-stat and a
  "generated <date>" stamp; refreshes replace items, never delete user edits.
- Burnout guard on all of them: burned tracks (§4) sit out their 90-day cooldown.
- Incognito plays excluded from any playlist a friend could see; opt-in only for Guilty Pleasures.

## 8. Prediction without Spotify's brain

Spotify's recommendation APIs are dead to us and the ToS bars ML over Spotify Content. The
engine below is deterministic retrieval over open data (ListenBrainz, MusicBrainz, Last.fm,
AcousticBrainz CC0) seeded by our own affinity scores — the only adaptive part is a per-user
bandit whose reward is the user's own play behavior. ToS-clean by construction.

### Substrate

- Track affinity `A_t` and artist affinity `A_a` from §1–5, plus **depth-appetite**
  `DA_a` = distinct loved tracks ÷ catalog size (does this user mine catalogs?).
- **User tag profile** `G_u`: normalized vector over MusicBrainz genres ∪ Last.fm tags, weighted
  by artist affinity — then clustered into 4–8 **taste clusters** (nobody is one blob).
- Eligibility filter on every candidate: unheard, not thumbs-downed, artist not burnout-suppressed.
- Every recommendation carries a provenance tag (which mechanism surfaced it) for credit assignment.

### The ten mechanisms (ranked by expected hit rate; hit = ≥80% completion within 30 days)

| # | mechanism | source | exp. hit | one-liner |
|---|---|---|---|---|
| M1 | **Deep Cuts of Loved Artists** | MusicBrainz discography (+AcousticBrainz mood-fit) | 22–30% | unheard tracks by high-affinity, high-depth-appetite artists; filter live/remix noise |
| M2 | **LB Recording Similarity** | ListenBrainz CF dataset | 12–18% | top-40 affinity tracks as seeds → similar recordings, popularity-penalized |
| M3 | **Last.fm Similar Tracks** | Last.fm API | 10–16% | same shape, different crowd — kept as a separate arm; the bandit learns which crowd fits |
| M4 | **Artist-Similarity Walk** | ListenBrainz + MB genres | 8–14% | ≤2-hop walk from top artists, cosine-gated to the user's genre envelope; hub-artist damping |
| M8 | **Friend Borrowing** | internal graph | 8–15%* | high-affinity tracks from taste-similar friends (τ≥0.4); *fires only when friends exist |
| M5 | **Tag-Cluster Matching** | Last.fm tags | 7–12% | match candidates to the *best-fitting taste cluster*, not the global average; idf-weight tags |
| M6 | **Collaborator/Producer/Label Hops** | MB relationships | 6–11% | "from the same room": featured artists 1.0, producers 0.7, indie labelmates 0.4; the signal streaming services don't do |
| M7 | **Sonic Nearest-Neighbor** | AcousticBrainz CC0 dump | 5–9% | ANN over mood/BPM/timbre vectors near the user's loved-centroids; pre-2022 catalog arm, genre-gated |
| M9 | **Taste-Trajectory Extrapolation** | tag centroids over time | 4–8% | fit a velocity vector to monthly taste centroids, recommend where you're *heading*; exploration arm |
| M10 | **Era/Scene Adjacency** | MB area + active years | 3–7% | co-located contemporaries of loved artists (Manchester '89, DC hardcore); pure discovery |

### The feedback loop (per-user bandit)

Each mechanism is an arm with a Beta(α,β) posterior. Rewards from the user's own behavior:
hit +1.0, save +0.7, early skip −0.7, ignored 30d −0.3 (interim rewards as pseudo-counts,
reconciled at day 30). Weekly decay ×0.95 keeps ~14 weeks of effective memory so taste drift
re-opens exploration. New users start at the population posterior (weak prior, ~2 weeks of
personal data overrides it).

**Weekly "Predicted for You" (30 tracks)**: 20% exploration floor (6 slots round-robin to
under-sampled arms) + Thompson sampling over the rest; no arm >40%; ≥4 arms represented;
cross-mechanism MMR rerank; max 2 tracks/artist (3 for M1 — deep cuts are the point); each
track labeled Safe or Stretch so the playlist reads as a journey.

### The accuracy dashboard (the receipts)

- Headline: **30-day hit rate with Wilson interval** — "68% ± 6% — you played 41 of 60 picks."
- Per-mechanism leaderboard with sparklines ("Deep Cuts is carrying you at 41%").
- **Control lift**: a few slots each week are random-eligible picks (tagged control); engine
  hit-rate minus control hit-rate is the one number that survives skepticism.
- Calibration curve (assigned score vs actual hit rate) as the honest self-audit.
- Taste-drift speedometer from M9's velocity vector.

## 9. Build order

Phase 1 (with genre enrichment):
1. **Calibration layer** (§6.1) — everything else is mis-weighted without it.
2. **Event value model + three clocks** (§1–2) replacing v0's flat playcount scoring.
3. **Session reconstruction** (30-min gap rule) — unlocks §6.2 sequence signals + Perfect Sequence/Cold Open playlists.
4. First playlist wave: **One-Artist Era, On Repeat One Night Only, Full Send, Gateway Drugs, This Week Every Year, Comeback Kids, One-Hit Wonder** — pure timestamp math, every one carries a wow-stat.
5. Dashboard v1 additions: Desert-Island Core, Persona Divergence, honeymoon-slope stat, quadrant map.

Phase 2:
6. Burnout guard + playlist writer (Top Songs of All Time, Heavy Rotation as auto-refreshed Spotify playlists).
7. Behavioral-mirror playlists (Deliberate/Background Noise pair as the marketing moment; Almost; 2:47 AM).
8. Enrichment joins → Signature Deep Cut, Superfan Percentile, genre snapshots, mood playlists via AcousticBrainz.

Phase 2.5 (prediction MVP):
9. M1 (Deep Cuts of Loved Artists) alone — highest hit rate, one data source, ships the "Predicted for You" surface.
10. Add M2/M3 + the bandit + control slots; then widen mechanisms as data lands.

Bad Week ships last, opt-in, with careful copy — after the product has earned trust.
