# abs-edge-cache

**A Cloudflare Worker + R2 + HTTP/3 (QUIC) edge-caching front door for [Audiobookshelf](https://www.audiobookshelf.org/)—with an automatic Free-Tier Circuit Breaker.**

`abs-edge-cache` sits in front of your self-hosted Audiobookshelf server (for example, behind a Cloudflare Tunnel) and turns Cloudflare's global edge into a smart, zero-maintenance caching layer for **currently playing audiobooks**, **cover art**, and **library metadata**, while keeping your full multi-terabyte library on your home server and working transparently with official Audiobookshelf mobile apps and the Web UI.

---

## Table of Contents

1. [Why This Exists](#1-why-this-exists)
2. [Why HTTP/3 (QUIC) Matters for Audiobooks](#2-why-http3-quic-matters-for-audiobooks)
3. [How It Works (Architecture)](#3-how-it-works-architecture)
4. [Key Design Decisions (Why Things Were Built This Way)](#4-key-design-decisions-why-things-were-built-this-way)
5. [The R2 Free-Tier Circuit Breaker (`FREE_TIER_GUARD`)](#5-the-r2-free-tier-circuit-breaker-free_tier_guard)
6. [Configuration & Environment Variables Reference](#6-configuration--environment-variables-reference)
7. [Step-by-Step Deployment Guide](#7-step-by-step-deployment-guide)
8. [Moving or Changing Your Domain / URL Later](#8-moving-or-changing-your-domain--url-later)
9. [Observability, Headers & Status Endpoint](#9-observability-headers--status-endpoint)
10. [Changelog & License](#10-changelog--license)

---

## 1. Why This Exists

Self-hosting Audiobookshelf at home is great because your entire audiobook library stays on your own local storage. However, running a home server comes with two everyday pain points:

1. **Slow Library Browsing & Cover Loading:** Scrolling through hundreds of book covers and library lists over a home upload connection (or waiting for a self-hosted disk array to spin up) can make the mobile apps and Web UI feel sluggish.
2. **Stream Drops When Switching Networks (Wi-Fi ↔ Cellular):** Walking out the front door or getting into the car while listening to a book causes your phone's IP address to change, severing the home server's TCP stream.

Moving an entire audiobook library to cloud storage is expensive, and hosting Audiobookshelf itself inside a cloud container adds monthly compute and persistent disk costs. **However, you only listen to 1–3 books at a time.**

By caching **only currently playing books** in Cloudflare R2 (which includes **10 GB/month of free storage and $0 egress fees**) and caching **covers + static metadata** at Cloudflare's edge cache, you get cloud-edge speed and seamless network handoffs for $0/month while your full library stays at home.

---

## 2. Why HTTP/3 (QUIC) Matters for Audiobooks

A key reason for placing a Cloudflare Worker in front of Audiobookshelf is **HTTP/3 over QUIC** between your mobile device and Cloudflare's edge:

* **Seamless Wi-Fi to Cellular Connection Migration:** Traditional HTTP/1.1 and HTTP/2 run over TCP, where a connection is strictly tied to a 4-tuple (`source IP, source port, destination IP, destination port`). The moment you walk out of Wi-Fi range and switch to 5G/LTE, your source IP changes and the TCP connection dies. **QUIC separates the logical connection ID from the underlying IP address and UDP port**, allowing an active audio download to migrate from Wi-Fi to cellular mid-stream without tearing down the connection.
* **No TCP Head-of-Line Blocking & Faster Handshakes (0-RTT / 1-RTT):** On lossy mobile networks, QUIC recovers from packet loss faster than TCP and resumes encrypted connections in a single round trip.
* **Verified Native Player Support (`AppleCoreMedia` & Modern Browsers):** Even when a mobile app's UI layer uses an HTTP/1.1 client (such as Dart's `dart:io`) for small JSON API calls, the OS media engine that actually streams the audio (`AppleCoreMedia` on iOS/iPadOS, `ExoPlayer` on Android, and all modern desktop/mobile browsers) automatically upgrades audio range requests (`/public/session/:id/track/:n`) to **HTTP/3 (QUIC)**.
* **Paired with `206 Partial Content` Byte-Range Streaming from R2:** Because cached audio tracks live right at Cloudflare's edge in R2 and support arbitrary byte-range requests (`Range: bytes=start-end`), even if a phone loses signal completely in an elevator or tunnel, it resumes from the exact byte offset at the nearest Cloudflare edge POP in milliseconds—without waiting on your home ISP uplink.

---

## 3. How It Works (Architecture)

```text
+-------------------------------------------------------------------+
|  Audiobookshelf Mobile App (iOS / Android) or Web Browser         |
|  - Audio player streams via HTTP/3 (QUIC) + HTTP 206 Range        |
|  - App UI fetches covers, library lists, and syncs progress       |
+-------------------------------------------------------------------+
                                  |
                                  |  HTTPS (HTTP/3 QUIC)
                                  v
+-------------------------------------------------------------------+
|  Cloudflare Worker: abs-edge-cache                                |
|                                                                   |
|  1. Scanner Blocker: Instant 404 for /.env, /.git, .php, etc.     |
|  2. R2 Audio Cache (/public/session/:sid/track/:n):               |
|     - HIT  -> Streams 206 Partial Content straight from R2        |
|     - MISS -> Proxies from ORIGIN & queues track into abs-warm    |
|  3. Edge Cache (Covers, Author Images, Static Library Metadata):  |
|     - HIT  -> Instant response from Cloudflare Edge Cache         |
|     - STALE-> Instant response + background refresh (SWR)         |
|     - WRITE-> Any non-playback edit bumps epoch & invalidates all |
|  4. Pass-Through (Login, WebSockets, Progress Sync, HLS):         |
|     - Proxies straight to ORIGIN so progress is never stale       |
+-------------------------------------------------------------------+
        |                         |                         |
        | R2 Binding (CACHE)      | Queue (WARM)            | Cache Miss / Progress / Auth
        v                         v                         v
+---------------+         +---------------+         +-------------------------------+
| Cloudflare R2 |<--------| Queue Worker  |-------->| Home Audiobookshelf Server    |
|  (abs-cache)  |  warms  |  (abs-warm)   | fetches | (via Cloudflare Tunnel)       |
|  9.0 GB Cap   |  tracks | concurrency=1 | tracks  | Full Library + SQLite + Auth  |
+---------------+         +---------------+         +-------------------------------+
```

---

## 4. Key Design Decisions (Why Things Were Built This Way)

### Why a "Front Door" Worker instead of a Sidecar or Local Sync Script?
Audiobookshelf has no built-in setting to rewrite audio stream URLs to an external CDN. If you run a sidecar script that uploads files to R2 on a separate domain, official Audiobookshelf mobile apps won't use it. By placing the Worker on the hostname you log into, **all official mobile apps (iOS, Android, third-party clients like Absorb/Plappa) and the Web UI work completely unmodified**.

### Why Warm on `POST /api/items/:id/play` (and Active Sessions) instead of Pre-Warming the Entire "Continue Listening" Shelf?
People frequently start an audiobook, listen for 20 minutes, and leave it sitting on their "Continue Listening" shelf for months while listening to other books. Automatically uploading every book on the "Continue Listening" shelf would fill R2 with abandoned books.
Instead:
* When you actually press **Play** (`POST /api/items/:id/play`), the Worker learns the session ID (`sess:<sid>`) and pushes that book's tracks into the **`abs-warm` Cloudflare Queue**.
* Your very first stream starts playing immediately from your home server (zero waiting), while the Queue worker downloads the book's tracks into R2 in the background (typically **15–35 seconds** for a full multi-track book).
* If you were *already* in the middle of a session before the cache warmed, the Worker also catches up automatically on `POST /api/session/:id/sync` or on the next track request (`GET /public/session/:id/track/:n`).

### Why Use R2 for Audio Instead of Cloudflare's Standard Edge Cache?
Cloudflare's standard CDN cache (`caches.default`) is great for small cover images and JSON responses, but it is **per-colo (per data center)** and **evicts large audio files unpredictably** if you haven't requested that specific chunk from that specific POP recently. If you switch from Wi-Fi to cellular and route to a neighboring POP, standard edge cache misses. **R2 is persistent object storage**: once a book is warmed into `abs-cache`, it stays pinned and accessible from **every Cloudflare edge location worldwide** across all your devices until you finish the book, the 9 GB LRU evictor rotates it out, or the 7-day lifecycle rule expires it.

### Why Are Listening Progress Endpoints Cached with a Per-User Progress Epoch?
If `GET /api/me/progress`, `GET /api/libraries/:id/personalized`, or `GET /api/items/:id?include=progress` returned a stale cached response, reopening the app on another device could jump backward in your book.
* **Rule:** Progress-bearing endpoints (`pjson`: `/api/libraries/:id/personalized`, `/api/me/progress`, `/api/me/items-in-progress`, `/api/me/listening-stats`, and `?include=progress`) use a **per-user progress epoch** (`pepoch:<userId>`).
  * Every time that user opens a session (`/play`), syncs progress (`/sync`), closes a session (`/close`), or updates progress (`PATCH /api/me/progress`), `pepoch:<userId>` bumps immediately so the very next Home screen or book detail request fetches fresh progress from `ORIGIN`.
  * Between progress writes, repeated Home screen and book detail loads hit the edge (`PJSON_FRESH_S = 60`, `PJSON_SWR_S = 600`) in `0 ms`!
* **What else is cached at the edge:**
  * **Web UI Static Bundles (`/_nuxt/*`, `.js`, `.css`, `.woff2`, `.svg`, `.ico`, `.webmanifest`):** Content-hashed Nuxt JS/CSS bundles, fonts, and icons are cached at Cloudflare's edge for **30 days** (`COVER_TTL_S`).
  * **Web UI SPA HTML Shell (`/`, `/login`, `/library/*`, etc., plus `/sw.js`):** Cached at Cloudflare's edge with a **5-minute fresh window** (`HTML_FRESH_S = 300`) and a **24-hour Stale-While-Revalidate window** (`HTML_SWR_S = 86400`) so the Web UI loads instantaneously while still picking up Audiobookshelf server updates automatically.
  * **Covers & Author Images (`/api/items/:id/cover`, `/api/authors/:id/image`):** Cached for **30 days** (`COVER_TTL_S`), keyed by query parameters (`width`, `format`, `raw`, `ts`).
  * **Static Library & Metadata Lists (`/api/libraries`, `/api/libraries/:id/items`, `/series`, `/authors`, `/collections`, `/filterdata`, `/stats`):** Cached per user with a **2-minute fresh window** (`JSON_FRESH_S = 120`) and a **1-hour Stale-While-Revalidate window** (`JSON_SWR_S = 3600`).
  * **Edge `304 Not Modified` (`ETag` / `If-None-Match`):** Whenever a client sends a matching `If-None-Match` header for cached covers, assets, HTML, JSON, or R2 audio, the Worker short-circuits with `304 Not Modified` (0 bytes).
  * **Smart `currentTime` Queue Warming:** When you press Play mid-book, the Queue sorts tracks so the **currently playing chapter and subsequent chapters warm into R2 first**, then wraps around to earlier chapters.

### How Instant Edit Invalidation Works (Epoch Counter)
What if you edit a book's title, match metadata, or upload a new cover? You don't want to see stale metadata for 2 minutes or a stale cover for 30 days.
* Every time a mutating request (`POST`, `PUT`, `PATCH`, `DELETE`) hits `/api/*`—**excluding** normal playback/progress calls (`/api/session/*`, `/api/me/*`, `/api/authorize`, `/api/items/:id/play`)—the Worker bumps a global `epoch` timestamp in KV and the local edge cache.
* Any cached entry whose `x-cached-at` timestamp is older than `epoch` is treated as expired on the very next read.

### How Authentication & Security Work at the Edge
* **Audio Tracks (`/public/session/:sid/track/:n`):** Audiobookshelf's native players do not send an `Authorization` header on `<audio>` / `AppleCoreMedia` range requests; the capability URL's random session UUID (`:sid`) is the credential. The Worker only serves an audio track from R2 if `:sid` matches an active session previously opened via an authenticated `POST /api/items/:id/play` (or `/api/session/:sid/sync`) call on your origin server.
* **Offline Book Downloads (`/api/items/:id/file/:ino[/download]` & `/s/item/:id/:file`):** When you push the **Download** button in the mobile app or Web UI to save a book locally to your phone/tablet:
  * **If the book is ALREADY cached in R2** (because you were streaming it earlier), the Worker verifies your auth token, maps the file inode/filename to the cached R2 track (`itemmap:<itemId>`), and serves the download **straight from Cloudflare R2 at maximum edge speed** (`x-abs-cache: HIT`).
  * **If the book is NOT in R2**, the Worker streams the download directly from your `ORIGIN` server (`x-abs-cache: MISS-NO-STORE`) and **never queues or stores the downloaded book into R2**—since you are saving the book locally on your device, there is no reason to waste R2 cache space on it.
* **JSON Metadata Cache:** The Worker never serves cached JSON metadata to a token unless your origin server has returned a `2xx` response for that exact token hash within the last **15 minutes** (`/__edge/v/<tokenHash>`).
* **Immediate Session & Token Revocation (`POST /api/session/:id/close`, `/logout`, `401`/`403`):**
  * As soon as a playback session closes (`POST /api/session/:id/close`), its `sess:<sid>` mapping is immediately deleted from KV so a closed session URL cannot be replayed against R2.
  * When a user logs out (`/logout` or `/api/logout`) or if your origin server ever rejects a token with `401`/`403`, the Worker writes a 30-day revocation tombstone (`revoked:<tokenHash>`) in KV, immediately cutting off both edge cache access and any R2 playback session opened by that token.
* **Optional Cryptographic `HS256` JWT Verification (`VERIFY_JWT = "yes"` + `JWT_SECRET`):**
  * **Disabled by default (`VERIFY_JWT = "no"`)** so users can deploy without extracting secrets from their server.
  * **When enabled (`VERIFY_JWT = "yes"` and `JWT_SECRET` set):**
    1. Every JWT (`Authorization: Bearer <token>`, `?token=<token>`, or cookie) is cryptographically verified at Cloudflare's edge using Web Crypto `HMAC-SHA256` (`HS256`) against Audiobookshelf's `tokenSecret` (`JWT_SECRET`).
    2. Standard JWT timing claims (`exp` expiration and `nbf` not-before) and KV revocation tombstones (`revoked:<tokenHash>`) are enforced before serving any cached cover, metadata, status readout, or R2 file download.
    3. Playback sessions (`sess:<sid>`) can only be registered by a cryptographically verified JWT and are bound to that user's `userId` and `tokenHash`. If a third party attempts to use a different user's token or if the session's parent token is revoked/expired, R2 refuses to serve the audio track.
  * **How to Extract `JWT_SECRET` (`tokenSecret`) from Audiobookshelf:**
    Audiobookshelf stores its `HS256` signing secret (`tokenSecret`) in `/config/absdatabase.sqlite` inside the `settings` table (`id = 'server-settings'`), or allows overriding it via environment variables if configured. You can extract it with:
    ```bash
    # On Linux / macOS / Windows with sqlite3 installed:
    sqlite3 /path/to/config/absdatabase.sqlite "SELECT json_extract(settings, '$.tokenSecret') FROM settings WHERE id = 'server-settings';"

    # Or if running Audiobookshelf in Docker:
    docker exec audiobookshelf sqlite3 /config/absdatabase.sqlite "SELECT json_extract(settings, '$.tokenSecret') FROM settings WHERE id = 'server-settings';"
    ```
    Then store it as an encrypted Cloudflare Worker Secret and enable `VERIFY_JWT`:
    ```bash
    npx wrangler secret put JWT_SECRET
    # Paste your tokenSecret value when prompted, then set "VERIFY_JWT": "yes" in wrangler.jsonc
    ```
* **Edge Brute-Force Login Rate Limiter (`MAX_LOGIN_ATTEMPTS`):** Failed `POST /login` or `POST /api/login` attempts are counted per client IP (`CF-Connecting-IP`). After `5` failed attempts, the IP is blocked at Cloudflare's edge with `429 Too Many Requests` for 15 minutes before reaching your home server.
* **Device-Platform & Geo-Country Session Lock (`SESSION_LOCK = "yes"`):** Playback sessions (`sess:<sid>`) are bound to the originating country (`cf.country`) and player OS family (e.g. `apple-media`, `android`, `windows`). Your phone can freely roam between Wi-Fi and cellular on the same device, while cross-country or cross-OS session replay attempts are blocked with `403 Forbidden`.
* **Hardened Security Headers:** Every response sets `Referrer-Policy: no-referrer` (preventing `?token=` or `/public/session/:sid/` leaks in `Referer` headers), `X-Content-Type-Options: nosniff`, and `X-Frame-Options: SAMEORIGIN`, while preserving Audiobookshelf's own CORS/CSP headers.
* **Unified `/` and `/audiobookshelf` Subpath Support:** Whether a client talks to `/api/...` (mobile apps) or `/audiobookshelf/api/...` (Web UI configured with a router base path), the Worker normalizes the canonical path so both share the exact same edge and R2 cache entries.

---

## 5. The R2 Free-Tier Circuit Breaker (`FREE_TIER_GUARD`)

Cloudflare R2's free tier includes **10 GB-month of storage**, **1,000,000 Class A operations/month**, and **10,000,000 Class B operations/month** (with **free egress** and **free deletes**).

To guarantee that you **never** receive an unexpected R2 bill, `abs-edge-cache` includes a built-in, three-dimensional **Free-Tier Circuit Breaker** controlled by `FREE_TIER_GUARD` (enabled by default: `FREE_TIER_GUARD = "yes"`):

| R2 Billing Dimension | Cloudflare Free Tier | Default Guard Ceiling | How It Is Enforced |
| :--- | :--- | :--- | :--- |
| **1. Storage Volume** | `10.0 GB` (`10,000,000,000` B) | **`9.0 GB`** (`MAX_BUCKET_BYTES = 9000000000`) | Before writing any track, the Queue consumer sums all objects in `abs-cache`. If `current + newTrack > 9.0 GB`, it automatically deletes the **oldest cached book(s)** (excluding the book currently playing). If 9.0 GB still cannot be maintained, it refuses the write. |
| **2. Class A Ops** (`PUT`, `LIST`) | `1,000,000 / month` | **`800,000 / month`** (`MAX_CLASS_A_MONTH = 800000`) | Counts every `put` and `list` call in KV (`r2:usage:YYYY-MM`). At `800,000` (80% of free tier), the circuit breaker trips and disables R2 for the rest of the calendar month. |
| **3. Class B Ops** (`GET`, `HEAD`) | `10,000,000 / month` | **`8,000,000 / month`** (`MAX_CLASS_B_MONTH = 8000000`) | Counts every `get` and `head` call in KV (`r2:usage:YYYY-MM`). At `8,000,000` (80% of free tier), the circuit breaker trips and disables R2 for the rest of the calendar month. |

### Additional Built-In Storage Savers
* **Immediate Finished-Book Eviction:** As soon as you finish a book (or mark it finished via `PATCH /api/me/progress/:id` with `{"isFinished": true}`), the Worker deletes all of that book's tracks from R2 in the background.
* **7-Day R2 Lifecycle Auto-Expiry:** Combined with an R2 bucket lifecycle rule that expires objects after 7 days (`604800` seconds) and aborts incomplete multipart uploads after 24 hours, abandoned books clean themselves up automatically.
* **Serialized Queue Consumer (`max_concurrency: 1`):** Ensures two background warming workers can never race past the 9.0 GB check concurrently.
* **Want Unlimited Paid R2 Instead?** Set `FREE_TIER_GUARD = "no"` in `wrangler.jsonc` (or the Cloudflare dashboard) to turn off all R2 kill switches, storage ceilings, and KV operation counters.

---

## 6. Configuration & Environment Variables Reference

All settings are configured via environment variables (`vars` in `wrangler.jsonc`) and Resource Bindings:

### Resource Bindings

| Binding Name | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `ORIGIN` | Plain Text Variable | **Yes** | Full base URL of your Audiobookshelf server (e.g., `https://audiobookshelf-origin.example.com`). |
| `KV` | KV Namespace | **Yes** | Stores active session-to-track maps (`sess:*`), cache invalidation `epoch`, and monthly circuit-breaker counters (`r2:usage:YYYY-MM`). |
| `CACHE` | R2 Bucket | Recommended | R2 bucket (`abs-cache`) that holds cached audiobook audio tracks. (If omitted, audio proxies directly from `ORIGIN` while edge caching still works.) |
| `WARM` | Queue Producer | Recommended | Cloudflare Queue (`abs-warm`) that warms tracks into `CACHE` in the background. |

### Environment Variables (`vars`)

| Variable | Default | Description |
| :--- | :--- | :--- |
| `ORIGIN` | *(required)* | Origin URL of your Audiobookshelf instance (must be reachable by Cloudflare, e.g. via Cloudflare Tunnel). |
| `VERIFY_JWT` | `"no"` | Set to `"yes"` (along with the `JWT_SECRET` Worker Secret) to enable cryptographic `HS256` JWT signature verification, `exp`/`nbf` enforcement, cover-cache auth enforcement, and session-to-user binding at the edge. Disabled (`"no"`) by default. |
| `JWT_SECRET` | *(optional secret)* | Your Audiobookshelf server's `tokenSecret` (extracted from `/config/absdatabase.sqlite` or your server's env vars). Store via `npx wrangler secret put JWT_SECRET`. |
| `SESSION_LOCK` | `"yes"` | Binds playback sessions (`sess:<sid>`) to the originating country and player OS family (`403` on mismatch), while still allowing seamless Wi-Fi ↔ cellular roaming. Set to `"no"` to disable. |
| `MAX_LOGIN_ATTEMPTS` | `"5"` | Maximum failed `POST /login` attempts per IP before blocking with `429 Too Many Requests` for 15 minutes (`0` disables rate limiting). |
| `FREE_TIER_GUARD` | `"yes"` | Set to `"yes"` (default) to enforce the 9.0 GB storage cap and monthly Class A/B kill switches. Set to `"no"` (or `"false"` / `"off"` / `"0"`) to disable all R2 kill switches for paid R2 usage. |
| `MAX_BUCKET_BYTES` | `"9000000000"` | Maximum R2 bucket size in bytes when `FREE_TIER_GUARD="yes"`. Default is `9,000,000,000` (9.0 GB decimal / ~8.38 GiB), leaving 1.0 GB below R2's 10 GB free tier. |
| `MAX_BUCKET_MB` | `"9000"` | Alternative to `MAX_BUCKET_BYTES` specified in decimal megabytes (`1 MB = 1,000,000 bytes`). |
| `MAX_CLASS_A_MONTH` | `"800000"` | Monthly Class A operation ceiling (`PUT`, `LIST`) when `FREE_TIER_GUARD="yes"` (80% of R2's 1,000,000 free tier). |
| `MAX_CLASS_B_MONTH` | `"8000000"` | Monthly Class B operation ceiling (`GET`, `HEAD`) when `FREE_TIER_GUARD="yes"` (80% of R2's 10,000,000 free tier). |
| `MAX_WARM_MB` | `"2000"` | Maximum total size (in MiB) of a single book eligible for background warming (prevents a single huge box-set from flushing the bucket). |
| `R2_DISABLED` | `"false"` | Manual emergency kill switch. Set to `"true"` to immediately bypass R2 and stream all audio from `ORIGIN`. |
| `EDGE_CACHE` | `"on"` | Set to `"off"` to disable Cloudflare edge caching for covers and JSON metadata. |
| `COVER_TTL_S` | `"2592000"` | Edge cache TTL in seconds for book covers and author images (default: 30 days). |
| `JSON_FRESH_S` | `"120"` | Edge cache fresh window in seconds for static library/metadata JSON before Stale-While-Revalidate kicks in (default: 2 minutes). |
| `JSON_SWR_S` | `"3600"` | Edge cache Stale-While-Revalidate window in seconds for static JSON metadata (default: 1 hour). |
| `PJSON_FRESH_S` | `"60"` | Edge cache fresh window in seconds for progress-aware endpoints (`/personalized`, `/me/progress`) between `pepoch` bumps (default: 1 minute). |
| `PJSON_SWR_S` | `"600"` | Edge cache Stale-While-Revalidate window in seconds for progress-aware endpoints (default: 10 minutes). |
| `HTML_FRESH_S` | `"300"` | Edge cache fresh window in seconds for the Web UI SPA HTML shell and `/sw.js` (default: 5 minutes). |
| `HTML_SWR_S` | `"86400"` | Edge cache Stale-While-Revalidate window in seconds for the Web UI SPA HTML shell (default: 24 hours). |

---

## 7. Step-by-Step Deployment Guide

### Prerequisites
* A Cloudflare account with your domain zone added and **HTTP/3 (with QUIC)** enabled under **Zone → Network → HTTP/3 (with QUIC)**.
* Your Audiobookshelf server reachable at an origin hostname (e.g., via a Cloudflare Tunnel at `https://abs-origin.example.com`).
* R2 enabled on your Cloudflare account, and [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) installed (`npm install`).

### Step 1: Create the KV Namespace, R2 Bucket, and Queue
```bash
# 1. Create the KV namespace
npx wrangler kv namespace create KV

# 2. Create the R2 bucket for cached audio tracks
npx wrangler r2 bucket create abs-cache

# 3. Add a 7-day object expiration lifecycle rule on the R2 bucket (optional backstop)
npx wrangler r2 bucket lifecycle add abs-cache "Expire cached audio after 7 days" "" --expire-days 7 --abort-multipart-days 1

# 4. Create the background warming Queue
npx wrangler queues create abs-warm
```

### Step 2: Update `wrangler.jsonc`
Open `wrangler.jsonc` and set:
1. `"ORIGIN"` to your Audiobookshelf origin URL.
2. `"id"` under `"kv_namespaces"` to the KV namespace ID output in Step 1.
3. Adjust `"FREE_TIER_GUARD"` (`"yes"` for strict $0 free-tier enforcement, or `"no"` for unlimited paid R2).

### Step 3: Deploy the Worker
```bash
npm run deploy
```

### Step 4: Attach Your Custom Domain
In the Cloudflare Dashboard:
1. Go to **Workers & Pages → `abs-edge-cache` → Settings → Domains & Routes**.
2. Click **Add → Custom Domain** and enter your desired hostname (e.g., `audiobooks.example.com`).
3. Point your Audiobookshelf mobile app and browser to `https://audiobooks.example.com`.

---

## 8. Moving or Changing Your Domain / URL Later

Because `abs-edge-cache` stores **zero hardcoded hostnames** in R2 or KV keys, moving the Worker to a new URL—or promoting it from a test subdomain (like `audiobooks.example.com`) to your primary hostname (like `audiobookshelf.example.com`)—takes less than a minute and **preserves your entire R2 audio cache**:

1. **If you are just moving the Worker to a different public subdomain** (while keeping your origin tunnel on its existing internal/origin hostname):
   * Go to **Workers & Pages → `abs-edge-cache` → Settings → Domains & Routes**.
   * Add the new Custom Domain (and optionally remove the old one). No code change or redeploy is needed.
2. **If you want the Worker to take over your original `ORIGIN` hostname** (e.g., moving the Worker onto `audiobookshelf.example.com` where your Cloudflare Tunnel currently lives):
   * First, give your Cloudflare Tunnel a dedicated origin-only hostname in Zero Trust → Networks → Tunnels (e.g., `abs-origin.example.com`) pointing to your local Audiobookshelf port.
   * Update the `ORIGIN` environment variable on the Worker to `https://abs-origin.example.com`.
   * Remove the old `audiobookshelf.example.com` public hostname from the Tunnel and attach `audiobookshelf.example.com` as a Custom Domain on the Worker. All your devices already logged into `audiobookshelf.example.com` will seamlessly start using the Worker and R2 cache without even having to log in again!

---

## 9. Observability, Headers & Status Endpoint

### Response Headers
Every response passing through `abs-edge-cache` includes diagnostic headers:
* `x-abs-probe`: The client-to-Cloudflare HTTP protocol negotiated on that request (e.g., `HTTP/3`, `HTTP/2`, `HTTP/1.1`).
* `x-abs-cache`:
  * `HIT`: Served directly from Cloudflare R2 (for audio tracks) or Cloudflare Edge Cache (for covers and JSON metadata).
  * `STALE`: Served instantly from Cloudflare Edge Cache while a background refresh updates the cache (`Stale-While-Revalidate`).
  * `MISS`: Fetched from your `ORIGIN` server (and queued/stored into cache if eligible).
  * `BYPASS-LIMIT`: The R2 Free-Tier Circuit Breaker tripped (or `R2_DISABLED="true"`), so the audio stream was transparently proxied from `ORIGIN` to prevent R2 charges.

### Live R2 Budget & Circuit-Breaker Status Endpoint
Make an authenticated `GET` request to `/__abs-cache/status` (passing your Audiobookshelf `Authorization: Bearer <token>` header or `?token=<token>` after using the app):

```json
{
  "month": "2026-11",
  "freeTierGuard": "yes",
  "circuitBreakerTripped": false,
  "reason": "OK (within Free Tier safety limits)",
  "storage": {
    "currentBytes": 106271180,
    "currentMB": 106.27,
    "maxBytes": 9000000000,
    "maxMB": 9000,
    "percentUsed": 1.18
  },
  "classAOps": {
    "used": 35,
    "max": 800000,
    "freeTier": 1000000
  },
  "classBOps": {
    "used": 40,
    "max": 8000000,
    "freeTier": 10000000
  }
}
```

---

## 10. Changelog & License

* See [CHANGELOG.md](./CHANGELOG.md) for the full architectural history and release notes.
* Licensed under the [MIT License](./LICENSE).