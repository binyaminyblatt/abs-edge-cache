# Quickstart Guide (Plain-English Setup)

New to Cloudflare or networking? Start here. This guide explains what `abs-edge-cache` does, what each setting means in plain English, and how to set it up in a few minutes.

---

## What This Actually Does

Normally, when you listen to an audiobook away from home, your phone pulls the audio directly from your home computer. If your home internet upload is slow—or your phone switches from Wi-Fi to 5G—the stream can stutter or cut out.

**`abs-edge-cache`** puts a free Cloudflare helper in front of your existing Audiobookshelf server:
- **Your full library stays at home.** You don't upload your whole collection to the cloud.
- **Only the book you're listening to right now** gets temporarily copied to Cloudflare's fast servers. When you finish the book, it's automatically deleted to make room for the next one.
- **Your home server is never modified.** This only acts as a middleman. If anything ever goes wrong, it passes traffic straight through to your home server, and you can switch your app back to your old URL at any time.

---

## What Each Piece Does (No Jargon)

When you deploy this on Cloudflare, it sets up 4 pieces for you:

| Piece | What it is in plain English |
| :--- | :--- |
| **`ORIGIN`** | The web address your Audiobookshelf server is **already** using (for example, `https://abs-home.yourdomain.com`). |
| **`KV`** | A tiny notepad Cloudflare uses to remember which book is playing and keep track of your free-tier limits. |
| **`CACHE` (R2 Bucket)** | Free Cloudflare storage (10 GB free) that holds the audio chapters of the 1–3 books you're currently listening to. |
| **`WARM` (Queue)** | A background helper that quietly copies the next few chapters into `CACHE` while you listen, so your phone never has to wait. |

### Main Settings Explained

| Setting | Default | What it does |
| :--- | :--- | :--- |
| **`FREE_TIER_GUARD`** | `yes` | **Your automatic bill blocker.** Stops caching before you ever cross Cloudflare's free limits (9 GB storage cap + monthly operation caps), so you stay at **$0/month**. |
| **`VERIFY_JWT` + `JWT_SECRET`** | `no` | **Recommended security lock.** Makes Cloudflare double-check your Audiobookshelf login token before serving cached covers or files. *(See Step 3 below to turn this on.)* |
| **`SESSION_LOCK`** | `yes` | Prevents someone in another country or on a different type of device from reusing your audio link, while still letting your phone switch freely between Wi-Fi and 5G. |
| **`MAX_LOGIN_ATTEMPTS`** | `5` | Temporarily blocks anyone who guesses a wrong password 5 times in a row for 15 minutes. |
| **`WARM_WINDOW_TRACKS`** | `5` | How many chapters ahead to copy into Cloudflare at a time. Keeps storage small if you stop listening to a long book early. |
| **`PREWARM_IN_PROGRESS`** | `no` | Optional. If set to `yes`, Cloudflare starts copying your top *"Continue Listening"* books as soon as you open the app—before you even press Play. |

---

## How to Get Started (4 Steps)

### Step 1: Make sure your home server has its own web address
Your Audiobookshelf server needs to be reachable over HTTPS (for example, via a Cloudflare Tunnel at `https://abs-origin.yourdomain.com`).
> **Tip:** Keep that address as your *behind-the-scenes* address, and give this Worker a clean public address like `https://audiobooks.yourdomain.com`.

### Step 2: Click "Deploy to Cloudflare"
1. Go back to the [main README](./README.md) and click the **Deploy to Cloudflare** button.
2. Sign in to your free Cloudflare account (you may need to enable **R2** in the Cloudflare dashboard if you haven't used it before — the free tier includes 10 GB/month at \$0).
3. When asked for **`ORIGIN`**, paste your Audiobookshelf server's web address (e.g., `https://abs-origin.yourdomain.com`).
4. Finish the deploy! Cloudflare will automatically create the notepad (`KV`), storage (`CACHE`), and background helper (`WARM`).

### Step 3: Turn on the recommended security lock (`VERIFY_JWT`)
For any server on the public internet, we strongly recommend turning this on so Cloudflare verifies every login token:

1. Grab your Audiobookshelf secret key (`tokenSecret`) by running **one** of these commands on the machine running Audiobookshelf:
   ```bash
   # If using Docker:
   docker exec audiobookshelf sqlite3 /config/absdatabase.sqlite "SELECT json_extract(settings, '$.tokenSecret') FROM settings WHERE id = 'server-settings';"

   # If running directly with Python:
   python3 -c "import sqlite3, json; c=sqlite3.connect('/path/to/config/absdatabase.sqlite'); print(json.loads(c.execute(\"SELECT settings FROM settings WHERE id='server-settings'\").fetchone()[0])['tokenSecret'])"
   ```
2. In the **Cloudflare Dashboard**, go to **Workers & Pages → `abs-edge-cache` → Settings → Variables and Secrets**.
3. Click **Add**:
   * Add a **Secret** named `JWT_SECRET` and paste the value from step 1.
   * Change the variable `VERIFY_JWT` from `no` to `yes`.
4. Click **Deploy** / **Save**.

### Step 4: Connect your custom web address and your app
1. Still in **Workers & Pages → `abs-edge-cache` → Settings → Domains & Routes**, click **Add → Custom Domain** and enter the address you want to use (e.g., `audiobooks.yourdomain.com`).
2. *(Optional, but highly recommended)* In your Cloudflare Dashboard, go to your domain → **Speed → Settings → Protocol Optimization** and make sure **HTTP/3 (with QUIC)** is turned **On** (it is usually On by default) — this is what keeps audio from dropping when you leave Wi-Fi.
3. Open your Audiobookshelf app (or browser) and log in using **`https://audiobooks.yourdomain.com`**.

That's it! The first time you press Play on a book, it starts immediately from your home server while Cloudflare caches it in the background. After a few seconds, your stream and chapter skipping will come straight from Cloudflare.

---

## Want to Undo It?
Nothing on your home server was changed. Simply switch your phone app's server URL back to your original Audiobookshelf address (or delete the Worker in Cloudflare) and everything works exactly as before.
