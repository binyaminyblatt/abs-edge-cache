import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";

function installGlobals(originFetch) {
  const edgeStore = new Map();
  globalThis.caches = {
    default: {
      async match(req) {
        const key = typeof req === "string" ? req : req.url;
        const hit = edgeStore.get(key);
        return hit ? hit.clone() : undefined;
      },
      async put(req, resp) {
        const key = typeof req === "string" ? req : req.url;
        edgeStore.set(key, resp.clone());
      },
      async delete(req) {
        const key = typeof req === "string" ? req : req.url;
        return edgeStore.delete(key);
      }
    }
  };
  globalThis.FixedLengthStream = class {
    constructor() {
      const chunks = [];
      let resolveDone;
      const done = new Promise((r) => { resolveDone = r; });
      this.writable = new WritableStream({
        write(chunk) { chunks.push(new Uint8Array(chunk)); },
        close() { resolveDone(Buffer.concat(chunks)); }
      });
      this.readable = done;
    }
  };
  globalThis.fetch = originFetch;
  return edgeStore;
}

function makeKv() {
  const m = new Map();
  return {
    store: m,
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v) { m.set(k, String(v)); },
    async delete(k) { m.delete(k); }
  };
}

function makeR2() {
  const m = new Map();
  return {
    store: m,
    async head(k) {
      const o = m.get(k);
      if (!o) return null;
      return {
        key: k,
        size: o.data.length,
        httpEtag: o.etag,
        uploaded: o.uploaded,
        writeHttpMetadata(h) { if (o.contentType) h.set("content-type", o.contentType); }
      };
    },
    async get(k, opts = {}) {
      const o = m.get(k);
      if (!o) return null;
      let buf = o.data;
      let rangeObj = undefined;
      if (opts && opts.range) {
        const rh = typeof opts.range.get === "function" ? opts.range.get("range") : "";
        const match = /^bytes=(\d*)-(\d*)$/.exec(rh || "");
        if (match) {
          const start = match[1] ? parseInt(match[1], 10) : 0;
          const end = match[2] ? Math.min(parseInt(match[2], 10), o.data.length - 1) : o.data.length - 1;
          buf = o.data.subarray(start, end + 1);
          rangeObj = { offset: start, length: buf.length };
        }
      }
      return {
        key: k,
        size: o.data.length,
        httpEtag: o.etag,
        range: rangeObj,
        body: buf,
        writeHttpMetadata(h) { if (o.contentType) h.set("content-type", o.contentType); }
      };
    },
    async put(k, readable, opts = {}) {
      const data = await readable;
      m.set(k, {
        data: Buffer.from(data),
        etag: '"' + k + '"',
        uploaded: new Date().toISOString(),
        contentType: (opts.httpMetadata && opts.httpMetadata.contentType) || "audio/mpeg"
      });
    },
    async delete(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) m.delete(k);
    },
    async list(opts = {}) {
      const objs = [];
      for (const [k, v] of m.entries()) {
        if (opts.prefix && !k.startsWith(opts.prefix)) continue;
        objs.push({ key: k, size: v.data.length, uploaded: v.uploaded });
      }
      return { objects: objs, truncated: false };
    }
  };
}

function makeCtx() {
  const pending = [];
  return {
    waitUntil(p) { pending.push(Promise.resolve(p)); },
    async flush() { await Promise.allSettled(pending); }
  };
}

async function signJwt(payload, secret) {
  const enc = new TextEncoder();
  const b64u = (buf) => Buffer.from(buf).toString("base64url");
  const header = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64u(JSON.stringify(payload));
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(header + "." + body));
  return `${header}.${body}.${b64u(sig)}`;
}

function makeEnv(overrides = {}) {
  return {
    ORIGIN: "https://origin.example.com",
    FREE_TIER_GUARD: "yes",
    VERIFY_JWT: "no",
    SESSION_LOCK: "yes",
    MAX_LOGIN_ATTEMPTS: "5",
    MAX_BUCKET_BYTES: "9000000000",
    MAX_CLASS_A_MONTH: "800000",
    MAX_CLASS_B_MONTH: "8000000",
    MAX_WARM_MB: "2000",
    WARM_WINDOW_TRACKS: "5",
    KV: makeKv(),
    CACHE: makeR2(),
    WARM: { sent: [], async send(job) { this.sent.push(job); } },
    ...overrides
  };
}

test("scanner blocker returns instant 404 without hitting origin", async () => {
  let originCalls = 0;
  installGlobals(async () => { originCalls++; return new Response("nope"); });
  const env = makeEnv();
  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://edge.example.com/.env"), env, ctx);
  assert.equal(res.status, 404);
  assert.equal(originCalls, 0);
});

test("sliding-window track warming respects WARM_WINDOW_TRACKS and advances on track play", async () => {
  const tracks = Array.from({ length: 12 }, (_, i) => ({
    index: i + 1,
    contentUrl: `/public/session/sess-1/track/${i + 1}`,
    mimeType: "audio/mpeg",
    startOffset: i * 100,
    duration: 100,
    metadata: { size: 1000, filename: `ch${i + 1}.mp3` }
  }));
  installGlobals(async (req) => {
    const url = typeof req === "string" ? req : req.url;
    if (url.includes("/api/items/book-1/play")) {
      return new Response(JSON.stringify({
        id: "sess-1",
        libraryItemId: "book-1",
        userId: "user-1",
        currentTime: 250, // inside track 3 (index 2)
        audioTracks: tracks
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(Buffer.alloc(1000, 7), { status: 200, headers: { "content-length": "1000", "content-type": "audio/mpeg" } });
  });

  const env = makeEnv({ WARM_WINDOW_TRACKS: "3" });
  const ctx1 = makeCtx();
  const playReq = new Request("https://edge.example.com/api/items/book-1/play", {
    method: "POST",
    headers: { authorization: "Bearer tok", "user-agent": "Absorb/1.0 CFNetwork/1400 Darwin/22" }
  });
  Object.defineProperty(playReq, "cf", { value: { country: "US" } });
  const playRes = await worker.fetch(playReq, env, ctx1);
  assert.equal(playRes.status, 200);
  await ctx1.flush();

  // Only 3 tracks starting from active chapter (3, 4, 5) should be queued
  assert.deepEqual(env.WARM.sent.map((j) => j.n), ["3", "4", "5"]);

  // Now simulate listening to track 4: sliding window should enqueue track 6 (tracks 4 & 5 already flagged)
  const ctx2 = makeCtx();
  const track4Req = new Request("https://edge.example.com/public/session/sess-1/track/4", {
    headers: { "user-agent": "AppleCoreMedia/1.0.0.20" }
  });
  Object.defineProperty(track4Req, "cf", { value: { country: "US" } });
  await worker.fetch(track4Req, env, ctx2);
  await ctx2.flush();
  assert.deepEqual(env.WARM.sent.map((j) => j.n), ["3", "4", "5", "6"]);
});

test("R2 206 byte-range serving and 304 Not Modified work at edge", async () => {
  installGlobals(async () => new Response("origin", { status: 200 }));
  const env = makeEnv();
  await env.KV.put("sess:s1", JSON.stringify({
    item: "book-1",
    userId: "u1",
    country: "US",
    playerFamily: "apple-media",
    closed: false,
    trackOrder: ["1"],
    tracks: { "1": { key: "book-1/track-1", size: 10, mime: "audio/mpeg" } }
  }));
  await env.CACHE.put("book-1/track-1", Promise.resolve(Buffer.from("0123456789")), {
    httpMetadata: { contentType: "audio/mpeg" }
  });

  const ctx = makeCtx();
  const req = new Request("https://edge.example.com/public/session/s1/track/1", {
    headers: { range: "bytes=2-5", "user-agent": "AppleCoreMedia/1.0" }
  });
  Object.defineProperty(req, "cf", { value: { country: "US" } });
  const res = await worker.fetch(req, env, ctx);
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("content-range"), "bytes 2-5/10");
  assert.equal(res.headers.get("x-abs-cache"), "HIT");
  assert.equal(await res.text(), "2345");

  // 304 Not Modified on matching ETag
  const req304 = new Request("https://edge.example.com/public/session/s1/track/1", {
    headers: { "if-none-match": '"book-1/track-1"', "user-agent": "AppleCoreMedia/1.0" }
  });
  Object.defineProperty(req304, "cf", { value: { country: "US" } });
  const res304 = await worker.fetch(req304, env, ctx);
  assert.equal(res304.status, 304);
});

test("SESSION_LOCK blocks cross-country and cross-OS replay with 403", async () => {
  installGlobals(async () => new Response("origin", { status: 200 }));
  const env = makeEnv({ SESSION_LOCK: "yes" });
  await env.KV.put("sess:s1", JSON.stringify({
    item: "book-1",
    userId: "u1",
    country: "US",
    playerFamily: "apple-media",
    closed: false,
    tracks: { "1": { key: "book-1/track-1", size: 10, mime: "audio/mpeg" } }
  }));
  await env.CACHE.put("book-1/track-1", Promise.resolve(Buffer.from("0123456789")));

  const ctx = makeCtx();
  const badCountry = new Request("https://edge.example.com/public/session/s1/track/1", {
    headers: { "user-agent": "AppleCoreMedia/1.0" }
  });
  Object.defineProperty(badCountry, "cf", { value: { country: "DE" } });
  assert.equal((await worker.fetch(badCountry, env, ctx)).status, 403);

  const badOs = new Request("https://edge.example.com/public/session/s1/track/1", {
    headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
  });
  Object.defineProperty(badOs, "cf", { value: { country: "US" } });
  assert.equal((await worker.fetch(badOs, env, ctx)).status, 403);
});

test("MAX_LOGIN_ATTEMPTS rate-limits repeated failed logins with 429", async () => {
  installGlobals(async () => new Response("Unauthorized", { status: 401 }));
  const env = makeEnv({ MAX_LOGIN_ATTEMPTS: "2" });
  const ctx = makeCtx();

  for (let i = 0; i < 2; i++) {
    const r = new Request("https://edge.example.com/login", {
      method: "POST",
      headers: { "cf-connecting-ip": "1.2.3.4" }
    });
    const res = await worker.fetch(r, env, ctx);
    assert.equal(res.status, 401);
    await ctx.flush();
  }

  const blocked = await worker.fetch(new Request("https://edge.example.com/login", {
    method: "POST",
    headers: { "cf-connecting-ip": "1.2.3.4" }
  }), env, ctx);
  assert.equal(blocked.status, 429);

  // IPv6 /64 prefix normalization: 2 failed attempts from ::1 block ::2 in same /64
  for (let i = 0; i < 2; i++) {
    await worker.fetch(new Request("https://edge.example.com/login", {
      method: "POST",
      headers: { "cf-connecting-ip": "2001:db8:1234:5678::1" }
    }), env, ctx);
    await ctx.flush();
  }
  const v6Blocked = await worker.fetch(new Request("https://edge.example.com/login", {
    method: "POST",
    headers: { "cf-connecting-ip": "2001:db8:1234:5678::9999" }
  }), env, ctx);
  assert.equal(v6Blocked.status, 429);
});

test("VERIFY_JWT rejects forged tokens and accepts valid HS256 JWTs", async () => {
  installGlobals(async () => new Response(JSON.stringify({ libraries: [] }), {
    status: 200,
    headers: { "content-type": "application/json" }
  }));
  const secret = "super-secret-abs-key";
  const env = makeEnv({ VERIFY_JWT: "yes", JWT_SECRET: secret });
  const ctx = makeCtx();

  const badRes = await worker.fetch(new Request("https://edge.example.com/__abs-cache/status", {
    headers: { authorization: "Bearer forged.jwt.token" }
  }), env, ctx);
  assert.equal(badRes.status, 401);

  const goodJwt = await signJwt({ userId: "u1", exp: Math.floor(Date.now() / 1000) + 3600 }, secret);
  const goodRes = await worker.fetch(new Request("https://edge.example.com/__abs-cache/status", {
    headers: { authorization: `Bearer ${goodJwt}` }
  }), env, ctx);
  assert.equal(goodRes.status, 200);
});

test("FREE_TIER_GUARD trips circuit breaker when Class A ops reach MAX_CLASS_A_MONTH", async () => {
  const month = new Date().toISOString().slice(0, 7);
  installGlobals(async () => new Response("audio", { status: 200, headers: { "content-length": "5" } }));
  const env = makeEnv({ MAX_CLASS_A_MONTH: "2" });
  await env.KV.put("r2:usage:" + month, JSON.stringify({ month, a: 0, b: 0, bytes: 0, tripped: false }));

  // Trigger a queue batch with 1 track: listAllObjects (1) + CACHE.put (1) = 2 >= MAX_CLASS_A_MONTH
  await worker.queue({
    messages: [{
      body: { sid: "s1", item: "book-1", n: "1", key: "book-1/track-1", size: 5, mime: "audio/mpeg" },
      ack() {},
      retry() {}
    }]
  }, env);

  const state = JSON.parse(await env.KV.get("r2:usage:" + month));
  assert.equal(state.tripped, true);
});

test("STALE-IF-ERROR serves expired edge cache when origin is offline", async () => {
  let originDown = false;
  installGlobals(async () => {
    if (originDown) throw new Error("ECONNREFUSED");
    return new Response(JSON.stringify({ libraries: [{ id: "lib-1" }] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  });

  const env = makeEnv({ JSON_FRESH_S: "0", JSON_SWR_S: "0" });
  const ctx1 = makeCtx();
  const res1 = await worker.fetch(new Request("https://edge.example.com/api/libraries", {
    headers: { authorization: "Bearer valid-tok" }
  }), env, ctx1);
  assert.equal(res1.status, 200);
  await ctx1.flush();

  // Origin goes offline; expired cache entry should be served with STALE-IF-ERROR
  originDown = true;
  await new Promise((r) => setTimeout(r, 10));
  const ctx2 = makeCtx();
  const res2 = await worker.fetch(new Request("https://edge.example.com/api/libraries", {
    headers: { authorization: "Bearer valid-tok" }
  }), env, ctx2);
  assert.equal(res2.status, 200);
  assert.equal(res2.headers.get("x-abs-cache"), "STALE-IF-ERROR");
  const body = await res2.json();
  assert.equal(body.libraries[0].id, "lib-1");
});

test("offline progress writes are queued and replayed when origin recovers, while non-progress POSTs fail with 502", async () => {
  let originStatus = 503;
  const replayed = [];
  installGlobals(async (req, opts) => {
    const url = typeof req === "string" ? req : req.url;
    if (originStatus >= 500) return new Response("Unavailable", { status: originStatus });
    const method = typeof req === "string" ? ((opts && opts.method) || "GET") : req.method;
    const body = typeof req === "string" ? ((opts && opts.body) || "") : await req.text();
    replayed.push({ url, method, body });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });

  const secret = "offline-test-secret";
  const env = makeEnv({ VERIFY_JWT: "yes", JWT_SECRET: secret });
  const ctx = makeCtx();
  const validJwt = await signJwt({ userId: "u1", exp: Math.floor(Date.now() / 1000) + 3600 }, secret);

  // Forged token while origin is down -> NOT queued, passes through 503
  const badSyncRes = await worker.fetch(new Request("https://edge.example.com/api/session/s1/sync", {
    method: "POST",
    headers: { authorization: "Bearer forged.tok.here", "content-type": "application/json" },
    body: JSON.stringify({ currentTime: 999 })
  }), env, ctx);
  assert.equal(badSyncRes.status, 503);
  assert.equal(env.WARM.sent.length, 0);

  // Valid JWT progress sync while origin is down -> queued & 200 OK
  const syncRes = await worker.fetch(new Request("https://edge.example.com/api/session/s1/sync", {
    method: "POST",
    headers: { authorization: `Bearer ${validJwt}`, "content-type": "application/json" },
    body: JSON.stringify({ currentTime: 420 })
  }), env, ctx);
  assert.equal(syncRes.status, 200);
  assert.equal(syncRes.headers.get("x-abs-cache"), "QUEUED-OFFLINE");
  assert.equal(env.WARM.sent.length, 1);
  assert.equal(env.WARM.sent[0].type, "progress");

  // Non-progress POST while origin is down -> NOT queued, passes through 503
  const playRes = await worker.fetch(new Request("https://edge.example.com/api/items/b1/play", {
    method: "POST",
    headers: { authorization: "Bearer tok" }
  }), env, ctx);
  assert.equal(playRes.status, 503);
  assert.equal(env.WARM.sent.length, 1);

  // Queue replay while origin is still down -> retry()
  let retried = 0, acked = 0;
  await worker.queue({
    messages: [{ body: env.WARM.sent[0], ack() { acked++; }, retry() { retried++; } }]
  }, env);
  assert.equal(retried, 1);
  assert.equal(acked, 0);

  // Origin recovers -> ack() and progress body replayed
  originStatus = 200;
  await worker.queue({
    messages: [{ body: env.WARM.sent[0], ack() { acked++; }, retry() { retried++; } }]
  }, env);
  assert.equal(acked, 1);
  assert.equal(replayed.length, 1);
  assert.equal(JSON.parse(replayed[0].body).currentTime, 420);
});

test("RSS feed XML and audio enclosures are cached at edge and in R2", async () => {
  let originHits = 0;
  installGlobals(async (req) => {
    originHits++;
    const url = typeof req === "string" ? req : req.url;
    if (url.endsWith("/feed/my-slug")) {
      return new Response("<rss><channel><title>Book</title></channel></rss>", {
        status: 200,
        headers: { "content-type": "application/rss+xml" }
      });
    }
    return new Response("RSSAUDIO99", {
      status: 200,
      headers: { "content-length": "10", "content-type": "audio/mpeg" }
    });
  });

  const env = makeEnv();
  const ctx = makeCtx();

  // 1. RSS XML miss -> hit
  const rss1 = await worker.fetch(new Request("https://edge.example.com/feed/my-slug"), env, ctx);
  assert.equal(rss1.status, 200);
  await ctx.flush();
  const rss2 = await worker.fetch(new Request("https://edge.example.com/feed/my-slug"), env, ctx);
  assert.equal(rss2.status, 200);
  assert.equal(rss2.headers.get("x-abs-cache"), "HIT");

  // 2. RSS audio miss queues rss-track job, then queue warms R2, then 206 HIT from R2
  const aud1 = await worker.fetch(new Request("https://edge.example.com/feed/my-slug/ch1.mp3"), env, ctx);
  assert.equal(aud1.status, 200);
  await ctx.flush();
  assert.equal(env.WARM.sent.length, 1);
  assert.equal(env.WARM.sent[0].type, "rss-track");

  await worker.queue({
    messages: [{ body: env.WARM.sent[0], ack() {}, retry() {} }]
  }, env);

  const aud2 = await worker.fetch(new Request("https://edge.example.com/feed/my-slug/ch1.mp3", {
    headers: { range: "bytes=0-2" }
  }), env, ctx);
  assert.equal(aud2.status, 206);
  assert.equal(aud2.headers.get("x-abs-cache"), "HIT");
  assert.equal(await aud2.text(), "RSS");
});

test("top-level fetch fails open to origin on unexpected internal error", async () => {
  installGlobals(async () => new Response("origin-ok", { status: 200 }));
  // Pass a malformed env.ORIGIN or force an internal throw? Instead, pass a broken request.url getter?
  // Simpler: pass a custom env where ORIGIN is valid but caches.default.match throws, or test normal fail-open:
  // Trigger an unexpected throw inside handleFetch by making request.headers.get throw on first call
  const env = makeEnv();
  const ctx = makeCtx();
  const origReq = new Request("https://edge.example.com/api/ping");
  let threw = false;
  const proxyReq = new Proxy(origReq, {
    get(target, prop) {
      if (prop === "headers" && !threw) {
        threw = true;
        throw new Error("simulated unexpected worker bug");
      }
      const val = Reflect.get(target, prop);
      return typeof val === "function" ? val.bind(target) : val;
    }
  });
  // Note: request.clone() is called before handleFetch, so let's make clone() return origReq
  proxyReq.clone = () => origReq;
  const res = await worker.fetch(proxyReq, env, ctx);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-abs-cache"), "FAIL-OPEN");
  assert.equal(await res.text(), "origin-ok");
});

test("cached download verifies origin permission (blocks 403) and formats non-ASCII Content-Disposition", async () => {
  installGlobals(async (req, opts) => {
    const url = typeof req === "string" ? req : req.url;
    const hdrs = typeof req === "string" ? new Headers(opts && opts.headers) : req.headers;
    const auth = hdrs.get("authorization") || "";
    if (url.endsWith("/api/me")) {
      return new Response(JSON.stringify({ id: "u1" }), { status: 200 });
    }
    if (url.includes("/api/items/b1/file/ino1/download")) {
      if (auth === "Bearer restricted-tok") {
        return new Response("Forbidden", { status: 403 });
      }
      return new Response("A", { status: 206, headers: { "content-range": "bytes 0-0/10" } });
    }
    return new Response("ok", { status: 200 });
  });

  const env = makeEnv();
  const ctx = makeCtx();
  await env.CACHE.put("b1/track-1", Buffer.from("0123456789"), {
    httpMetadata: { contentType: "audio/mpeg" }
  });
  await env.KV.put("itemmap:b1", JSON.stringify({
    count: 1,
    byIno: { ino1: { key: "b1/track-1", size: 10, mime: "audio/mpeg", filename: "Book — Ch 1 (א).mp3" } },
    byFile: {}
  }));

  // Prime credential validity for restricted-tok via /api/me
  await worker.fetch(new Request("https://edge.example.com/api/me", {
    headers: { authorization: "Bearer restricted-tok" }
  }), env, ctx);
  await ctx.flush();

  // Restricted user gets 403 from origin check and does NOT receive cached R2 file
  const denied = await worker.fetch(new Request("https://edge.example.com/api/items/b1/file/ino1/download", {
    headers: { authorization: "Bearer restricted-tok" }
  }), env, ctx);
  assert.equal(denied.status, 403);

  // Permitted user gets cached R2 file with RFC 5987 Content-Disposition
  await worker.fetch(new Request("https://edge.example.com/api/me", {
    headers: { authorization: "Bearer allowed-tok" }
  }), env, ctx);
  await ctx.flush();

  const ok = await worker.fetch(new Request("https://edge.example.com/api/items/b1/file/ino1/download", {
    headers: { authorization: "Bearer allowed-tok" }
  }), env, ctx);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("x-abs-cache"), "HIT");
  const cd = ok.headers.get("content-disposition") || "";
  assert.ok(cd.includes('filename="Book _ Ch 1 (_).mp3"'));
  assert.ok(cd.includes("filename*=UTF-8''Book%20%E2%80%94%20Ch%201%20%28%D7%90%29.mp3"));
});

test("VERIFY_JWT=yes without JWT_SECRET fails closed with 500", async () => {
  installGlobals(async () => new Response("origin-should-not-run", { status: 200 }));
  const env = makeEnv({ VERIFY_JWT: "yes", JWT_SECRET: "" });
  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://edge.example.com/api/me"), env, ctx);
  assert.equal(res.status, 500);
});

test("PROBE_LOG is off by default and does not write probe keys to KV", async () => {
  installGlobals(async () => new Response("ok", { status: 200 }));
  const env = makeEnv();
  const ctx = makeCtx();
  await worker.fetch(new Request("https://edge.example.com/api/ping"), env, ctx);
  await ctx.flush();
  const probeKeys = Array.from(env.KV.store.keys()).filter((k) => k.startsWith("p:"));
  assert.equal(probeKeys.length, 0);
});

test("RSS audio miss does not enqueue warm job when origin returns 404", async () => {
  installGlobals(async () => new Response("Not Found", { status: 404 }));
  const env = makeEnv();
  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://edge.example.com/feed/my-slug/missing.mp3"), env, ctx);
  assert.equal(res.status, 404);
  await ctx.flush();
  assert.equal(env.WARM.sent.length, 0);
});

test("stale R2 object with mismatched size is treated as cache miss", async () => {
  installGlobals(async () => new Response("FRESH_ORIGIN_AUDIO", { status: 200 }));
  const env = makeEnv();
  const ctx = makeCtx();
  await env.CACHE.put("b1/track-1", Buffer.from("SHORT"), {
    httpMetadata: { contentType: "audio/mpeg" }
  });
  await env.KV.put("sess:s1", JSON.stringify({
    item: "b1",
    tracks: { "1": { key: "b1/track-1", size: 18, mime: "audio/mpeg" } },
    trackOrder: ["1"]
  }));

  const res = await worker.fetch(new Request("https://edge.example.com/public/session/s1/track/1"), env, ctx);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-abs-cache"), "MISS");
  assert.equal(await res.text(), "FRESH_ORIGIN_AUDIO");
});

test("compressed IPv6 addresses share /64 login rate-limit bucket and 200 login does not reset counter", async () => {
  let nextStatus = 401;
  installGlobals(async () => new Response("auth", { status: nextStatus }));
  const env = makeEnv({ MAX_LOGIN_ATTEMPTS: "3" });
  const ctx = makeCtx();

  for (const ip of ["2001:db8::1", "2001:0db8:0000:0000::2"]) {
    const r = await worker.fetch(new Request("https://edge.example.com/login", {
      method: "POST",
      headers: { "cf-connecting-ip": ip },
      body: "{}"
    }), env, ctx);
    assert.equal(r.status, 401);
    await ctx.flush();
  }

  // Successful login should NOT reset the failed-attempt counter
  nextStatus = 200;
  const ok = await worker.fetch(new Request("https://edge.example.com/login", {
    method: "POST",
    headers: { "cf-connecting-ip": "2001:db8:0:0::3" },
    body: "{}"
  }), env, ctx);
  assert.equal(ok.status, 200);
  await ctx.flush();

  // Third failed attempt from another address in the same /64 triggers 429 on fourth
  nextStatus = 401;
  const r3 = await worker.fetch(new Request("https://edge.example.com/login", {
    method: "POST",
    headers: { "cf-connecting-ip": "2001:db8::4" },
    body: "{}"
  }), env, ctx);
  assert.equal(r3.status, 401);
  await ctx.flush();

  const blocked = await worker.fetch(new Request("https://edge.example.com/login", {
    method: "POST",
    headers: { "cf-connecting-ip": "2001:db8::5" },
    body: "{}"
  }), env, ctx);
  assert.equal(blocked.status, 429);
});

test("malformed URI on /s/item/:id/:file returns 400 Bad Request", async () => {
  installGlobals(async () => new Response("ok", { status: 200 }));
  const env = makeEnv();
  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://edge.example.com/s/item/b1/%E0%A4%A"), env, ctx);
  assert.equal(res.status, 400);
});

test("PREWARM_IN_PROGRESS=yes pre-warms active chapter on items-in-progress without storing tokens in KV", async () => {
  const tracks = [
    { index: 1, ino: "ino-1", mimeType: "audio/mpeg", startOffset: 0, duration: 100, metadata: { size: 5, filename: "ch1.mp3" } },
    { index: 2, ino: "ino-2", mimeType: "audio/mpeg", startOffset: 100, duration: 100, metadata: { size: 5, filename: "ch2.mp3" } },
    { index: 3, ino: "ino-3", mimeType: "audio/mpeg", startOffset: 200, duration: 100, metadata: { size: 5, filename: "ch3.mp3" } }
  ];
  installGlobals(async (req, opts) => {
    const url = typeof req === "string" ? req : req.url;
    const hdrs = typeof req === "string" ? new Headers(opts && opts.headers) : req.headers;
    const auth = hdrs.get("authorization") || "";
    assert.ok(auth === "Bearer secret-user-token" || auth === "Bearer secret-user-token-on");
    if (url.endsWith("/api/me/items-in-progress")) {
      return new Response(JSON.stringify({ libraryItems: [{ id: "book-pre-1" }, { id: "book-pre-2" }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (url.includes("/api/items/book-pre-1")) {
      if (url.includes("/file/")) {
        return new Response("AUDIO", { status: 200, headers: { "content-length": "5", "content-type": "audio/mpeg" } });
      }
      return new Response(JSON.stringify({
        id: "book-pre-1",
        userMediaProgress: { currentTime: 150 }, // inside track 2
        media: { tracks }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/api/items/book-pre-2")) {
      return new Response(JSON.stringify({ id: "book-pre-2", media: { tracks: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response("ok", { status: 200 });
  });

  // Off by default: should NOT pre-warm
  const envOff = makeEnv();
  const ctxOff = makeCtx();
  await worker.fetch(new Request("https://edge.example.com/api/me/items-in-progress", {
    headers: { authorization: "Bearer secret-user-token" }
  }), envOff, ctxOff);
  await ctxOff.flush();
  assert.equal(envOff.CACHE.store.size, 0);

  // Enabled with PREWARM_IN_PROGRESS=yes & PREWARM_MAX_BOOKS=1 & WARM_WINDOW_TRACKS=2
  const envOn = makeEnv({ PREWARM_IN_PROGRESS: "yes", PREWARM_MAX_BOOKS: "1", WARM_WINDOW_TRACKS: "2" });
  const ctxOn = makeCtx();
  const res = await worker.fetch(new Request("https://edge.example.com/api/me/items-in-progress", {
    headers: { authorization: "Bearer secret-user-token-on" }
  }), envOn, ctxOn);
  assert.equal(res.status, 200);
  await ctxOn.flush();

  // Only tracks 2 and 3 of book-pre-1 should be warmed (track 1 skipped because currentTime=150 is in track 2)
  assert.equal(envOn.CACHE.store.has("book-pre-1/track-1"), false);
  assert.equal(envOn.CACHE.store.has("book-pre-1/track-2"), true);
  assert.equal(envOn.CACHE.store.has("book-pre-1/track-3"), true);

  // Ensure raw Bearer token is NEVER stored anywhere in KV
  for (const [k, v] of envOn.KV.store.entries()) {
    assert.ok(!String(k).includes("secret-user-token-on") && !String(v).includes("secret-user-token-on"));
  }
});