# Changelog

All notable changes and architectural milestones of `abs-edge-cache` are documented in this file.

---

## [1.0.0] - 2026-11-24

### Added
- **Web UI Static Asset & HTML Shell Edge Caching (`/_nuxt/*`, `.js`, `.css`, fonts, icons, SPA HTML):**
  - Cached content-hashed Nuxt JS/CSS bundles (`/_nuxt/*`), fonts, and icons at Cloudflare's edge for 30 days.
  - Cached the Nuxt SPA HTML shell (`/`, `/login`, `/library/*`, etc.) and `/sw.js` with a 5-minute fresh window (`HTML_FRESH_S = 300`) and 24-hour stale-while-revalidate window (`HTML_SWR_S = 86400`).
- **Read-Only R2 Acceleration for Local Book Downloads (`/api/items/:id/file/:ino` & `/s/item/:id/:file`):**
  - When a user presses the **Download** button in the mobile app or Web UI, the Worker checks if the book is already cached in R2:
    - If **already in R2** (`HIT`), the download is served directly from Cloudflare R2 at edge speed (after verifying the user's auth token).
    - If **not in R2** (`MISS-NO-STORE`), the download streams directly from `ORIGIN` and **never warms or stores the book into R2**, avoiding wasting R2 storage on books being saved locally to a device.
- **R2 Free-Tier Circuit Breaker (`FREE_TIER_GUARD`):**
  - Added an opt-out Free-Tier Guard (`FREE_TIER_GUARD="yes"` by default, set to `"no"` for unlimited paid R2 mode) that protects all three billable Cloudflare R2 dimensions:
    1. **Storage Volume Cap (`MAX_BUCKET_BYTES = 9,000,000,000` / 9.0 GB):** Enforces a 1.0 GB safety buffer under Cloudflare R2's 10 GB-month free tier using automatic oldest-book LRU eviction before every write.
    2. **Monthly Class A Operation Kill Switch (`MAX_CLASS_A_MONTH = 800,000`):** Caps `PUT` and `LIST` operations at 80% of R2's 1,000,000/month free tier.
    3. **Monthly Class B Operation Kill Switch (`MAX_CLASS_B_MONTH = 8,000,000`):** Caps `GET` and `HEAD` operations at 80% of R2's 10,000,000/month free tier.
  - When any threshold is reached (or when `R2_DISABLED="true"`), the circuit breaker trips for the rest of the calendar month (`YYYY-MM`), disabling all R2 calls and transparently streaming audio from `ORIGIN` with `x-abs-cache: BYPASS-LIMIT`.
- **Authenticated Budget & Circuit-Breaker Status Endpoint (`GET /__abs-cache/status`):**
  - Added a live JSON diagnostic endpoint (protected by Audiobookshelf Bearer/token authentication) showing current R2 storage usage (`bytes`, `MB`, `%`), monthly Class A and Class B operation counters, and circuit breaker health.
- **Batch-Level R2 Inventory Snapshot Optimization:**
  - Updated the Queue consumer (`queue(batch, env)`) to call `env.CACHE.list()` once per batch rather than once per track, cutting Class A `list()` operations by up to 80%, and cached positive `warm:<key>` flags in KV for 24 hours so repeated `/play` calls across devices don't issue redundant R2 `HEAD` requests.
- **Immediate Finished-Book R2 Eviction (`PATCH /api/me/progress`):**
  - Automatically deletes all cached R2 audio tracks for a book in the background as soon as a user finishes it (`isFinished: true`).
- **Unified `/audiobookshelf` Base-Path Normalization & Mid-Session Catch-Up:**
  - Added `stripBase()` so deployments accessed at `/` (mobile apps) and `/audiobookshelf` (Web UI behind a subpath) share the exact same Edge Cache and R2 Audio Cache entries.
  - Fixed track index resolution in `learnSessionData()` to fall back to `t.index` when `t.contentUrl` does not contain `/track/<n>`.
  - Added automatic mid-session catch-up on `POST /api/session/:id/sync` and on-miss track queuing so already-running playback sessions warm into R2 without requiring a fresh `/play` request.
- **Edge Caching for Covers, Author Images & Static Library Metadata:**
  - Cached `/api/items/:id/cover` and `/api/authors/:id/image` at Cloudflare's edge for 30 days (`COVER_TTL_S = 2592000`), including width/format query variants and Web UI `<img>` requests.
  - Cached static metadata endpoints (`/api/libraries`, `/api/libraries/:id/items`, `/series`, `/authors`, `/collections`, `/filterdata`, `/stats`) per user with a 2-minute fresh window (`JSON_FRESH_S = 120`) and 1-hour stale-while-revalidate window (`JSON_SWR_S = 3600`).
  - Added instant epoch-based cache invalidation whenever any write (`POST`/`PUT`/`PATCH`/`DELETE`) other than playback/progress hits `/api/*`.
  - Deliberately excluded progress-bearing endpoints (`/api/me/progress`, `/api/libraries/:id/personalized`, `?include=progress`) so resume positions are never stale.
- **R2 Audio Streaming & Background Queue Warming (`abs-warm`):**
  - Intercepts `POST /api/items/:id/play` to map playback session IDs (`sess:<sid>`) to library item tracks in KV and enqueues background warming jobs into Cloudflare Queues (`abs-warm`).
  - Serves `GET` and `HEAD` `/public/session/:id/track/:n` directly from Cloudflare R2 with full HTTP `206 Partial Content` byte-range (`Range` / `Content-Range`) support.
- **Bot & Scanner Blocking:**
  - Immediately drops internet scanner probes (`/.env`, `/.git`, `/actuator`, `/wp-*`, `.php`, `.sql`, `.bak`, etc.) at the edge with `404 Not Found` before they touch the home server tunnel.
- **HTTP/3 (QUIC) & Protocol Probe Telemetry:**
  - Verified native HTTP/3 (QUIC) audio streaming from mobile players (`AppleCoreMedia` on iOS/iPadOS) and desktop browsers, recording privacy-preserving request shape telemetry (`p:*`) in KV without logging tokens, passwords, or personal IDs.
