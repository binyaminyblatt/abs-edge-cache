# Changelog

All notable changes and architectural milestones of `abs-edge-cache` are documented in this file.

---

## [1.0.0] - 2026-11-24

### Added
- **Audio Streaming & Scrubbing Benchmark Script (`scripts/benchmark.mjs`):**
  - Added `npm run benchmark` (`ABS_EDGE_URL`, `ABS_ORIGIN_URL`, `ABS_TOKEN`, optional `ABS_ITEM_ID`) to measure Origin vs. Edge (R2 `HIT`) play-start TTFB, random `64 KB` scrubbing/seeking latency, and `10 MB` streaming throughput, then close the temporary session cleanly.
- **Offline-Origin Resilience (`STALE-IF-ERROR` & Queued Progress Writes):**
  - Falls back to serving expired edge-cached covers, library metadata, RSS feeds, and Web UI shell (`x-abs-cache: STALE-IF-ERROR`) if `ORIGIN` is unreachable or returns `502`/`503`/`504`/`520`–`530`.
  - Queues progress writes (`POST /api/session/:id/sync`, `POST /api/session/:id/close`, `PATCH /api/me/progress*`) into `abs-warm` (`x-abs-cache: QUEUED-OFFLINE`) when `ORIGIN` is offline and automatically replays them once `ORIGIN` recovers.
- **RSS Feed Edge & R2 Caching (`/feed/:slug` & `/feed/:slug/*`):**
  - Edge-caches `/feed/:slug` XML feeds (`RSS_FRESH_S = 300`, `RSS_SWR_S = 3600`) and warms/serves RSS `<enclosure>` audio files from R2 with `206` byte-range support.
- **Sliding-Window Track Warming (`WARM_WINDOW_TRACKS`):**
  - Bounds background R2 warming to `WARM_WINDOW_TRACKS` chapters from the active chapter forward (default `5`; set to `0` to warm the entire book immediately) and automatically advances the window as you listen through multi-file audiobooks.
- **One-Click Deploy to Cloudflare Button & Test Suite:**
  - Added the `Deploy to Cloudflare` button to `README.md` with binding descriptions in `package.json`.
  - Added a `node --test` unit test suite (`npm test`) covering `206` byte-range R2 streaming, `WARM_WINDOW_TRACKS`, `FREE_TIER_GUARD`, `SESSION_LOCK`, `MAX_LOGIN_ATTEMPTS`, `VERIFY_JWT`, `epoch`/`pepoch` invalidation, and `304 Not Modified`.
- **Smart `currentTime` Queue Warming Priority:**
  - Sorts `abs-warm` queue jobs using the session's `currentTime`, `startOffset`, and `duration` so the active chapter and subsequent chapters warm into R2 first, then wraps around to earlier chapters.
- **Progress-Aware Edge Caching (`pepoch:<userId>`):**
  - Caches `/api/libraries/:id/personalized`, `/api/me/progress`, `/api/me/items-in-progress`, `/api/me/listening-stats`, and `?include=progress` with a per-user progress epoch (`PJSON_FRESH_S = 60`, `PJSON_SWR_S = 600`) that invalidates immediately on `/play`, `/sync`, `/close`, or `PATCH /api/me/progress`.
- **Edge `304 Not Modified` (`ETag` / `If-None-Match`) Short-Circuiting:**
  - Returns `304 Not Modified` (0 bytes) at the edge when `If-None-Match` matches cached `ETag` headers on Edge Cache or R2 responses.
- **Edge Brute-Force Login Rate Limiting (`MAX_LOGIN_ATTEMPTS = 5`):**
  - Blocks IPs with `429 Too Many Requests` for 15 minutes after 5 failed `POST /login` or `POST /api/login` attempts.
- **Device-Platform & Geo-Country Session Lock (`SESSION_LOCK = "yes"`):**
  - Binds `sess:<sid>` to originating `cf.country` and player OS family, blocking cross-country or cross-OS session replay with `403 Forbidden` while permitting Wi-Fi ↔ cellular roaming.
- **Hardened Security Headers:**
  - Adds `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, and `X-Frame-Options: SAMEORIGIN` while preserving Audiobookshelf's own CORS/CSP headers.
- **Optional Cryptographic `HS256` JWT Verification & Session Revocation (`VERIFY_JWT` + `JWT_SECRET`):**
  - Added optional edge cryptographic verification (`VERIFY_JWT="no"` by default; enabled when `VERIFY_JWT="yes"` and `JWT_SECRET` is set to Audiobookshelf's `tokenSecret`) using Web Crypto `HMAC-SHA256`.
  - Validates JWT signatures, `exp` / `nbf` claims, and KV revocation tombstones (`revoked:<tokenHash>`) before serving any cached metadata, covers, status, or R2 audio/downloads.
  - Binds playback sessions (`sess:<sid>`) to the authenticated `userId` and `tokenHash`, immediately deletes `sess:<sid>` from KV on `POST /api/session/:id/close`, and revokes tokens immediately on `/logout` or origin `401`/`403` responses.
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