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
    playerFamily: "apple",
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
