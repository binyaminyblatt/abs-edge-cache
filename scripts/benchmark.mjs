import { execFileSync } from "node:child_process";

const TOKEN = process.env.ABS_TOKEN;
const EDGE = (process.env.ABS_EDGE_URL || "").replace(/\/+$/, "");
const ORIG = (process.env.ABS_ORIGIN_URL || "").replace(/\/+$/, "");

if (!TOKEN || !EDGE || !ORIG) {
  console.error("Usage: set ABS_TOKEN, ABS_EDGE_URL, and ABS_ORIGIN_URL environment variables.");
  process.exit(1);
}

const UA = "Absorb/1.0 CFNetwork/1400 Darwin/22";

async function api(base, path, method = "GET", body = undefined) {
  const headers = { Authorization: `Bearer ${TOKEN}`, "User-Agent": UA };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(base + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  if (!res.ok) throw new Error(`${method} ${base}${path} -> ${res.status} ${await res.text()}`);
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : res.text();
}

function curlBatch(urls, rangeHeaders, sendAuth = false) {
  const args = ["-s"];
  const nullDev = process.platform === "win32" ? "NUL" : "/dev/null";
  for (let i = 0; i < urls.length; i++) {
    args.push("-o", nullDev);
  }
  if (rangeHeaders && rangeHeaders.length === 1) {
    args.push("-H", `Range: ${rangeHeaders[0]}`);
  }
  if (sendAuth) {
    args.push("-H", `Authorization: Bearer ${TOKEN}`);
  }
  args.push("-H", `User-Agent: ${UA}`);
  args.push("-w", "%{http_code}|%{time_starttransfer}|%{time_total}|%{speed_download}|%{size_download}\\n");
  for (const u of urls) args.push(u);
  const curlBin = process.platform === "win32" ? "curl.exe" : "curl";
  const out = execFileSync(curlBin, args, { encoding: "utf8" });
  return out.trim().split(/\r?\n/).map((line) => {
    const [code, ttfb, total, speed, size] = line.split("|");
    return {
      code: Number(code),
      ttfbMs: Math.round(Number(ttfb) * 1000 * 10) / 10,
      totalMs: Math.round(Number(total) * 1000 * 10) / 10,
      mbps: Math.round((Number(speed) * 8 / 1e6) * 100) / 100,
      mbSec: Math.round((Number(speed) / (1024 * 1024)) * 100) / 100,
      size: Number(size)
    };
  });
}

function stats(arr, key) {
  const vals = arr.map((x) => x[key]).sort((a, b) => a - b);
  const mid = Math.floor(vals.length / 2);
  const median = vals.length % 2 ? vals[mid] : Math.round(((vals[mid - 1] + vals[mid]) / 2) * 10) / 10;
  const avg = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
  return { min: vals[0], median, avg, max: vals[vals.length - 1], values: vals };
}

async function main() {
  const libs = await api(EDGE, "/api/libraries");
  const libId = libs.libraries[0].id;
  const items = await api(EDGE, `/api/libraries/${libId}/items?limit=25`);
  const item = (process.env.ABS_ITEM_ID && items.results.find((it) => it.id === process.env.ABS_ITEM_ID))
    || items.results.find((it) => it.media && it.media.duration > 3600)
    || items.results[0];
  console.log(`Book: "${item.media?.metadata?.title || item.id}" (${item.id})`);

  const sess = await api(EDGE, `/api/items/${item.id}/play`, "POST", {
    deviceInfo: { clientName: "Absorb", deviceId: "benchmark-runner" },
    supportedMimeTypes: ["audio/mpeg", "audio/mp4", "audio/aac", "audio/flac", "audio/ogg", "audio/opus", "audio/m4b"],
    mediaPlayer: "AppleCoreMedia"
  });
  const track = sess.audioTracks[0];
  const trackUrl = `/public/session/${sess.id}/track/1`;
  const needsAuth = false;
  const trackSize = track.metadata?.size || 0;
  console.log(`Session: ${sess.id} | Track 1: ${(trackSize / 1048576).toFixed(1)} MB (${trackUrl}, contentUrl=${track.contentUrl})`);

  const warmStart = Date.now();
  let warmed = false;
  for (let i = 0; i < 40; i++) {
    const hHeaders = { "User-Agent": UA };
    if (needsAuth) hHeaders.Authorization = `Bearer ${TOKEN}`;
    const h = await fetch(EDGE + trackUrl, { method: "HEAD", headers: hHeaders });
    if (h.headers.get("x-abs-cache") === "HIT") {
      warmed = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(`R2 warm status: ${warmed ? `HIT in ${((Date.now() - warmStart) / 1000).toFixed(1)}s` : "TIMED OUT (still MISS)"}`);

  const chunkEnd = Math.min(10485759, Math.max(1048575, trackSize - 1));
  const chunkMB = ((chunkEnd + 1) / 1048576).toFixed(1);

  try {
    // 1. Play-Start TTFB (64KB range, 1 warmup + 5 measured on reused connection)
    const origTtfb = curlBatch(Array(6).fill(ORIG + trackUrl), ["bytes=0-65535"], needsAuth).slice(1);
    const edgeTtfb = curlBatch(Array(6).fill(EDGE + trackUrl), ["bytes=0-65535"], needsAuth).slice(1);
    console.log("\n--- 1. Play-Start TTFB (64 KB Range, 5 runs, reused connection) ---");
    console.log("ORIGIN:", stats(origTtfb, "ttfbMs"), "HTTP:", origTtfb[0].code);
    console.log("EDGE  :", stats(edgeTtfb, "ttfbMs"), "HTTP:", edgeTtfb[0].code);

    // 2. Scrubbing / Seeking Latency (64KB jumps at 10%, 25%, 50%, 75%, 90%)
    const offsets = [0.1, 0.25, 0.5, 0.75, 0.9].map((p) => {
      const start = Math.floor(trackSize * p);
      return `bytes=${start}-${Math.min(start + 65535, trackSize - 1)}`;
    });
    const measureScrub = (base) => offsets.map((rng) => curlBatch([base + trackUrl, base + trackUrl], [rng], needsAuth)[1]);
    const origScrub = measureScrub(ORIG);
    const edgeScrub = measureScrub(EDGE);
    console.log("\n--- 2. Scrubbing / Seeking TTFB (64 KB jumps at 10/25/50/75/90%) ---");
    console.log("ORIGIN:", stats(origScrub, "ttfbMs"));
    console.log("EDGE  :", stats(edgeScrub, "ttfbMs"));

    // 3. Streaming Throughput (up to 10 MB chunk, 1 warmup + 3 measured)
    const origStream = curlBatch(Array(4).fill(ORIG + trackUrl), [`bytes=0-${chunkEnd}`], needsAuth).slice(1);
    const edgeStream = curlBatch(Array(4).fill(EDGE + trackUrl), [`bytes=0-${chunkEnd}`], needsAuth).slice(1);
    console.log(`\n--- 3. Streaming Throughput (${chunkMB} MB chunk, 3 runs) ---`);
    console.log("ORIGIN MB/s :", stats(origStream, "mbSec"), "| Total ms:", stats(origStream, "totalMs"), "| Sizes:", origStream.map((x) => x.size));
    console.log("EDGE   MB/s :", stats(edgeStream, "mbSec"), "| Total ms:", stats(edgeStream, "totalMs"), "| Sizes:", edgeStream.map((x) => x.size));
  } finally {
    await api(EDGE, `/api/session/${sess.id}/close`, "POST");
    console.log("\nSession closed cleanly.");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
