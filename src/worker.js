// abs-edge-cache: Cloudflare Worker front door for Audiobookshelf
// - blocks scanner/bot paths, rate-limits brute-force logins at the edge, proxies everything else to ORIGIN
// - edge-caches Web UI HTML shell, CSS, JS (_nuxt/*), fonts, icons, book covers, static metadata,
//   and progress-aware personalized shelves/book details (invalidated instantly on progress sync or edits)
// - supports Edge 304 Not Modified (ETag / If-None-Match) short-circuiting
// - learns playback sessions, prioritizes warming the active chapter (currentTime) first via Queue,
//   and serves cached audio from R2 with device-family + country session locking
// - accelerates offline book downloads (/api/items/:id/file/:ino, /s/item/:id/:file) from R2 if ALREADY cached,
//   without warming/storing downloaded books into R2 on a miss
// - optional Cryptographic JWT Verification (VERIFY_JWT = "yes" + JWT_SECRET)
// - optional Free-Tier R2 Circuit Breaker (FREE_TIER_GUARD = "yes" by default; set to "no" for unlimited paid R2)

const ID_RE = /^(li|ses|usr|lib|ser|aut|col|pl|ep|fol|dev)_[a-z0-9]+$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILE_RE = /\.(mp3|m4b|m4a|flac|ogg|opus|aac|wav|jpg|jpeg|png|webp|m3u8|ts|m4s|mp4|epub|pdf)$/i;
const BLOCK_DOT = /\/\.(?!well-known\/)/;
const BLOCK_PATH = /^\/(actuator|_vti|wp-|wordpress|phpmyadmin|cgi-bin|server-status|vendor\/|xmlrpc|boaform|HNAP1|ecp\/|owa\/|solr\/|jenkins|manager\/html)/i;
const BLOCK_EXT = /\.(php\d?|aspx?|jsp|cgi|sql|bak|ini|ya?ml|conf|env|git|log|swp|tar|gz|zip)$/i;
const APP_PATH = /^\/(api|public|s|hls|socket\.io|login|logout|status|ping|auth|feed|_nuxt)(\/|$)/;
const NOBUMP = /^\/api\/(session|me|authorize|items\/[^/]+\/play)(\/|$)/;
const PROGRESS_WRITE_RE = /^\/api\/(session(\/|$)|me\/progress(\/|$)|items\/[^/]+\/play(\/|$))/;
const OFFLINE_PROGRESS_QUEUE_RE = /^\/api\/(session\/[^/]+\/(sync|close)|me\/progress(\/[^/]+)?)$/;
const STATIC_ASSET_RE = /^\/_nuxt\/.+|\.(css|js|mjs|woff2?|ttf|otf|eot|svg|ico|webp|png|jpg|jpeg|gif|webmanifest|map)$/i;
const NON_HTML_PREFIX = /^\/(api|public|s|hls|socket\.io|auth|feed|logout|status|ping)(\/|$)/;

const DEFAULT_MAX_BUCKET_BYTES = 9000000000;
const DEFAULT_MAX_CLASS_A = 800000;
const DEFAULT_MAX_CLASS_B = 8000000;

var pendingClassA = 0;
var pendingClassB = 0;
var cachedBreakerState = null;
var cachedBreakerAt = 0;
var cachedHmacKey = null;
var cachedHmacSecret = "";

function num(v, d) { var n = parseInt(v, 10); return isNaN(n) ? d : n; }

function isOriginDownStatus(status) {
  return status === 502 || status === 503 || status === 504 || (status >= 520 && status <= 530);
}

function isTruthyFlag(v, defaultVal) {
  if (v === undefined || v === null || String(v).trim() === "") return defaultVal;
  var s = String(v).trim().toLowerCase();
  return (s === "yes" || s === "true" || s === "on" || s === "1");
}

function isFreeTierGuardEnabled(env) {
  return isTruthyFlag(env.FREE_TIER_GUARD, true);
}

function isJwtVerifyEnabled(env) {
  return isTruthyFlag(env.VERIFY_JWT, false) && Boolean(env.JWT_SECRET && String(env.JWT_SECRET).trim());
}

function isSessionLockEnabled(env) {
  return isTruthyFlag(env.SESSION_LOCK, true);
}

function applySecurityHeaders(h) {
  if (!h.has("referrer-policy")) h.set("referrer-policy", "no-referrer");
  if (!h.has("x-content-type-options")) h.set("x-content-type-options", "nosniff");
  if (!h.has("x-frame-options")) h.set("x-frame-options", "SAMEORIGIN");
}

function checkNotModified(request, respHeaders, cacheLabel) {
  if ((request.method !== "GET" && request.method !== "HEAD") || request.headers.has("range")) return null;
  var inm = request.headers.get("if-none-match");
  var etag = respHeaders.get("etag");
  if (!inm || !etag) return null;
  var cleanInm = inm.replace(/^W\//, "").trim();
  var cleanEtag = etag.replace(/^W\//, "").trim();
  if (cleanInm !== cleanEtag && inm.trim() !== "*") return null;
  var h = new Headers();
  h.set("etag", etag);
  if (respHeaders.has("cache-control")) h.set("cache-control", respHeaders.get("cache-control"));
  if (cacheLabel) h.set("x-abs-cache", cacheLabel);
  h.set("x-abs-probe", (request.cf && request.cf.httpProtocol) || "unknown");
  applySecurityHeaders(h);
  return new Response(null, { status: 304, headers: h });
}

function detectPlayerFamily(ua) {
  if (!ua) return "unknown";
  if (/AppleCoreMedia/i.test(ua)) return "apple-media";
  if (/ExoPlayer|Android|Dalvik/i.test(ua)) return "android";
  if (/iPhone|iPad|iPod|CFNetwork|Darwin/i.test(ua)) return "ios";
  if (/Dart/i.test(ua)) return "dart";
  if (/Windows/i.test(ua)) return "windows";
  if (/Macintosh|Mac OS X/i.test(ua)) return "mac";
  if (/Linux/i.test(ua)) return "linux";
  return "other";
}

function monthKey() {
  return "r2:usage:" + new Date().toISOString().slice(0, 7);
}

function getLimits(env) {
  var guard = isFreeTierGuardEnabled(env);
  var maxBytes = guard ? DEFAULT_MAX_BUCKET_BYTES : 0;
  if (env.MAX_BUCKET_BYTES && guard) maxBytes = num(env.MAX_BUCKET_BYTES, DEFAULT_MAX_BUCKET_BYTES);
  else if (env.MAX_BUCKET_MB && guard) maxBytes = num(env.MAX_BUCKET_MB, 9000) * 1000000;
  return {
    guardEnabled: guard,
    maxBytes: maxBytes,
    maxClassA: guard ? num(env.MAX_CLASS_A_MONTH, DEFAULT_MAX_CLASS_A) : 0,
    maxClassB: guard ? num(env.MAX_CLASS_B_MONTH, DEFAULT_MAX_CLASS_B) : 0
  };
}

async function getR2State(env, forceRefresh) {
  if (isTruthyFlag(env.R2_DISABLED, false)) {
    return { a: 0, b: 0, bytes: 0, tripped: true, reason: "R2_DISABLED env flag set" };
  }
  var lim = getLimits(env);
  if (!lim.guardEnabled) {
    return { a: 0, b: 0, bytes: 0, tripped: false, reason: "FREE_TIER_GUARD=no (unlimited paid R2 mode)" };
  }
  var now = Date.now();
  if (!forceRefresh && cachedBreakerState && (now - cachedBreakerAt) < 30000) {
    return cachedBreakerState;
  }
  var state = { a: 0, b: 0, bytes: 0, tripped: false, reason: "" };
  try {
    if (env.KV) {
      var raw = await env.KV.get(monthKey(), { cacheTtl: 60 });
      if (raw) {
        var parsed = JSON.parse(raw);
        state.a = parsed.a || 0;
        state.b = parsed.b || 0;
        state.bytes = parsed.bytes || 0;
        state.tripped = Boolean(parsed.tripped);
        state.reason = parsed.reason || "";
      }
    }
  } catch (e) {}
  if (!state.tripped) {
    if (lim.maxClassA > 0 && state.a + pendingClassA >= lim.maxClassA) {
      state.tripped = true;
      state.reason = "Monthly Class A operation cap reached (" + lim.maxClassA + ")";
    } else if (lim.maxClassB > 0 && state.b + pendingClassB >= lim.maxClassB) {
      state.tripped = true;
      state.reason = "Monthly Class B operation cap reached (" + lim.maxClassB + ")";
    }
  }
  cachedBreakerState = state;
  cachedBreakerAt = now;
  return state;
}

async function recordR2Ops(env, addA, addB, knownBytes, forceFlush, tripReason) {
  var lim = getLimits(env);
  if (!lim.guardEnabled) return;
  pendingClassA += (addA || 0);
  pendingClassB += (addB || 0);
  if (cachedBreakerState) {
    if (knownBytes !== undefined && knownBytes !== null) cachedBreakerState.bytes = knownBytes;
    if (tripReason) {
      cachedBreakerState.tripped = true;
      cachedBreakerState.reason = tripReason;
    } else if (lim.maxClassA > 0 && cachedBreakerState.a + pendingClassA >= lim.maxClassA) {
      cachedBreakerState.tripped = true;
      cachedBreakerState.reason = "Monthly Class A operation cap reached (" + lim.maxClassA + ")";
    } else if (lim.maxClassB > 0 && cachedBreakerState.b + pendingClassB >= lim.maxClassB) {
      cachedBreakerState.tripped = true;
      cachedBreakerState.reason = "Monthly Class B operation cap reached (" + lim.maxClassB + ")";
    }
  }
  if (!env.KV) return;
  if (!forceFlush && !tripReason && pendingClassA < 10 && pendingClassB < 50) return;
  var deltaA = pendingClassA;
  var deltaB = pendingClassB;
  pendingClassA = 0;
  pendingClassB = 0;
  try {
    var key = monthKey();
    var raw = await env.KV.get(key);
    var cur = raw ? JSON.parse(raw) : { a: 0, b: 0, bytes: 0, tripped: false, reason: "" };
    cur.a = (cur.a || 0) + deltaA;
    cur.b = (cur.b || 0) + deltaB;
    if (knownBytes !== undefined && knownBytes !== null) cur.bytes = knownBytes;
    if (tripReason) {
      cur.tripped = true;
      cur.reason = tripReason;
    } else if (!cur.tripped) {
      if (lim.maxClassA > 0 && cur.a >= lim.maxClassA) {
        cur.tripped = true;
        cur.reason = "Monthly Class A operation cap reached (" + lim.maxClassA + ")";
      } else if (lim.maxClassB > 0 && cur.b >= lim.maxClassB) {
        cur.tripped = true;
        cur.reason = "Monthly Class B operation cap reached (" + lim.maxClassB + ")";
      }
    }
    cur.updatedAt = new Date().toISOString();
    cachedBreakerState = cur;
    cachedBreakerAt = Date.now();
    await env.KV.put(key, JSON.stringify(cur), { expirationTtl: 3888000 });
  } catch (e) {}
}

function stripBase(pathname) {
  return pathname.replace(/^\/audiobookshelf(?=\/|$)/i, "") || "/";
}

function shape(pathname) {
  var s = pathname.split("/").map(function (seg) {
    if (!seg) return seg;
    if (ID_RE.test(seg) || UUID_RE.test(seg) || /^\d+$/.test(seg)) return ":id";
    if (FILE_RE.test(seg)) return ":file";
    return seg;
  }).join("/");
  return s.replace(/^(\/audiobookshelf)?\/s\/item\/[^/]+\/.*$/, "$1/s/item/:id/:file");
}

async function record(env, request, resp, url, cp) {
  try {
    if (!env.KV || !APP_PATH.test(cp)) return;
    var ua = (request.headers.get("user-agent") || "none").slice(0, 80);
    var cf = request.cf || {};
    var tokenIn = request.headers.get("authorization") ? "header" : (url.searchParams.has("token") ? "query" : "none");
    var entry = {
      method: request.method, shape: shape(url.pathname), status: resp.status,
      proto: cf.httpProtocol || "unknown", tokenIn: tokenIn, range: request.headers.has("range"),
      queryKeys: Array.from(url.searchParams.keys()).sort(), ua: ua, colo: cf.colo || "",
      cache: resp.headers.get("x-abs-cache") || "", seen: new Date().toISOString()
    };
    var key = ("p:" + [entry.method, entry.shape, Math.floor(resp.status / 100) + "xx", entry.proto, tokenIn, entry.cache, ua].join("|")).slice(0, 480);
    if ((await env.KV.get(key)) === null) {
      await env.KV.put(key, JSON.stringify(entry), { expirationTtl: 604800 });
    }
  } catch (e) {}
}

// ---------- Edge Brute-Force Login Rate Limiter ----------

function normalizeClientIp(ip) {
  if (!ip || ip === "unknown") return "unknown";
  if (ip.indexOf(":") !== -1) {
    return ip.split(":").slice(0, 4).join(":") + "::/64";
  }
  return ip;
}

async function checkLoginRateLimit(env, request, url) {
  try {
    var ip = normalizeClientIp(request.headers.get("cf-connecting-ip") || "unknown");
    var maxAttempts = num(env.MAX_LOGIN_ATTEMPTS, 5);
    if (maxAttempts <= 0) return { blocked: false, ip: ip };
    var cacheKey = url.origin + "/__edge/loginfail/" + ip;
    var hit = await caches.default.match(cacheKey);
    var count = hit ? (parseInt(await hit.text(), 10) || 0) : 0;
    if (count < maxAttempts && env.KV) {
      var kvCount = parseInt((await env.KV.get("loginfail:" + ip, { cacheTtl: 30 })) || "0", 10) || 0;
      if (kvCount > count) count = kvCount;
    }
    return { blocked: count >= maxAttempts, ip: ip, count: count };
  } catch (e) { return { blocked: false, ip: "unknown" }; }
}

async function recordLoginResult(env, url, ip, success) {
  try {
    if (!ip || ip === "unknown") return;
    var cacheKey = url.origin + "/__edge/loginfail/" + ip;
    if (success) {
      await caches.default.delete(cacheKey);
      if (env.KV) await env.KV.delete("loginfail:" + ip);
      return;
    }
    var hit = await caches.default.match(cacheKey);
    var count = hit ? (parseInt(await hit.text(), 10) || 0) : 0;
    if (env.KV) {
      var kvCount = parseInt((await env.KV.get("loginfail:" + ip)) || "0", 10) || 0;
      if (kvCount > count) count = kvCount;
    }
    var next = String(count + 1);
    await caches.default.put(cacheKey, new Response(next, { headers: { "cache-control": "max-age=900" } }));
    if (env.KV) await env.KV.put("loginfail:" + ip, next, { expirationTtl: 900 });
  } catch (e) {}
}

// ---------- Auth, Optional HS256 Cryptographic JWT Verification & Revocation ----------

async function sha16(s) {
  var d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).slice(0, 16).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
}

function b64UrlToBytes(b64url) {
  var b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4 !== 0) b64 += "=";
  var bin = atob(b64);
  var out = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function credential(request, url) {
  var a = request.headers.get("authorization");
  if (a && /^Bearer /i.test(a)) return a.slice(7).trim();
  var q = url.searchParams.get("token");
  if (q) return q.trim();
  var cookie = request.headers.get("cookie") || "";
  var cm = /(?:^|;\s*)(?:token|abs_token|auth\.token)=([^;]+)/i.exec(cookie);
  if (cm) {
    try { return decodeURIComponent(cm[1]).replace(/^Bearer\s+/i, "").trim(); } catch (e) {}
  }
  return "";
}

function parseJwtPayload(cred) {
  try {
    var p = cred.split(".");
    if (p.length !== 3) return null;
    var bytes = b64UrlToBytes(p[1]);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (e) { return null; }
}

function userOf(cred) {
  var j = parseJwtPayload(cred);
  if (!j) return "";
  return String(j.userId || j.id || j.sub || j.keyId || "");
}

async function getHmacKey(secret) {
  if (cachedHmacKey && cachedHmacSecret === secret) return cachedHmacKey;
  var keyBytes = new TextEncoder().encode(secret);
  cachedHmacKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  cachedHmacSecret = secret;
  return cachedHmacKey;
}

async function verifyJwtToken(env, cred) {
  try {
    if (!cred) return { valid: false, reason: "missing_token" };
    var parts = cred.split(".");
    if (parts.length !== 3) return { valid: false, reason: "malformed_jwt" };
    var header = JSON.parse(new TextDecoder().decode(b64UrlToBytes(parts[0])));
    if (!header || header.alg !== "HS256") return { valid: false, reason: "unsupported_alg" };

    var cleanSecret = String(env.JWT_SECRET).trim().replace(/^["']|["']$/g, "");
    var key = await getHmacKey(cleanSecret);
    var data = new TextEncoder().encode(parts[0] + "." + parts[1]);
    var sig = b64UrlToBytes(parts[2]);
    var ok = await crypto.subtle.verify("HMAC", key, sig, data);
    if (!ok) return { valid: false, reason: "invalid_signature" };

    var payload = JSON.parse(new TextDecoder().decode(b64UrlToBytes(parts[1])));
    var nowSec = Math.floor(Date.now() / 1000);
    if (payload.exp && typeof payload.exp === "number" && nowSec >= payload.exp) {
      return { valid: false, reason: "token_expired" };
    }
    if (payload.nbf && typeof payload.nbf === "number" && nowSec < payload.nbf - 30) {
      return { valid: false, reason: "token_not_yet_valid" };
    }

    var ch = await sha16(cred);
    if (env.KV) {
      var rev = await env.KV.get("revoked:" + ch, { cacheTtl: 60 });
      if (rev) return { valid: false, reason: "token_revoked" };
    }

    var uid = String(payload.userId || payload.id || payload.sub || payload.keyId || "");
    return { valid: true, userId: uid, tokenHash: ch, payload: payload };
  } catch (e) {
    return { valid: false, reason: "verify_exception" };
  }
}

async function revokeToken(env, request, url) {
  try {
    var cred = credential(request, url);
    if (!cred) return;
    var ch = await sha16(cred);
    await caches.default.delete(url.origin + "/__edge/v/" + ch);
    if (env.KV) {
      await env.KV.put("revoked:" + ch, String(Date.now()), { expirationTtl: 2592000 });
    }
  } catch (e) {}
}

async function markValid(env, request, url) {
  try {
    var cred = credential(request, url);
    if (!cred) return;
    if (isJwtVerifyEnabled(env)) {
      var v = await verifyJwtToken(env, cred);
      if (!v.valid) return;
    }
    var ch = await sha16(cred);
    if (env.KV) {
      var rev = await env.KV.get("revoked:" + ch, { cacheTtl: 60 });
      if (rev) return;
    }
    var k = url.origin + "/__edge/v/" + ch;
    if (await caches.default.match(k)) return;
    await caches.default.put(k, new Response("1", { headers: { "cache-control": "max-age=900" } }));
  } catch (e) {}
}

async function isCredentialValid(env, request, url) {
  var cred = credential(request, url);
  if (!cred) return false;
  var ch = await sha16(cred);
  if (env.KV) {
    var rev = await env.KV.get("revoked:" + ch, { cacheTtl: 60 });
    if (rev) return false;
  }
  if (isJwtVerifyEnabled(env)) {
    var v = await verifyJwtToken(env, cred);
    return v.valid;
  }
  var k = url.origin + "/__edge/v/" + ch;
  return Boolean(await caches.default.match(k));
}

// ---------- edge cache for Web UI assets (HTML/CSS/JS), covers, static & progress-aware metadata ----------

function normQuery(url) {
  var ps = [];
  url.searchParams.forEach(function (v, k) { if (k !== "token") ps.push(k + "=" + v); });
  ps.sort();
  return ps.join("&");
}

function classify(cp, search, request) {
  if (/^\/feed\/[^/]+$/.test(cp)) return "rss";
  if (/^\/api\/items\/[^/]+\/cover$/.test(cp) || /^\/api\/authors\/[^/]+\/image$/.test(cp)) return "cover";
  if (cp.indexOf("/api/") !== 0 && !NON_HTML_PREFIX.test(cp)) {
    if (cp === "/sw.js") return "html";
    if (STATIC_ASSET_RE.test(cp)) return "asset";
    var accept = request.headers.get("accept") || "";
    if (accept.indexOf("text/html") !== -1) return "html";
  }
  if (/rssfeed/i.test(search)) return null;
  if (/^\/api\/libraries\/[^/]+\/personalized$/.test(cp)
    || /^\/api\/me\/(progress|items-in-progress|listening-stats)$/.test(cp)) {
    return "pjson";
  }
  if (/^\/api\/libraries$/.test(cp)
    || /^\/api\/libraries\/[^/]+(\/(items|series|authors|collections|filterdata|stats))?$/.test(cp)
    || /^\/api\/items\/[^/]+$/.test(cp)
    || /^\/api\/authors\/[^/]+$/.test(cp)
    || /^\/api\/series\/[^/]+$/.test(cp)
    || /^\/api\/collections(\/[^/]+)?$/.test(cp)) {
    return /progress/i.test(search) ? "pjson" : "json";
  }
  return null;
}

async function getEpoch(env, cache, base) {
  var local = 0, remote = 0;
  var lm = await cache.match(base + "epoch");
  if (lm) local = parseInt(await lm.text(), 10) || 0;
  if (env.KV) remote = parseInt((await env.KV.get("epoch", { cacheTtl: 30 })) || "0", 10) || 0;
  return Math.max(local, remote);
}

async function bumpEpoch(env, base) {
  try {
    var now = String(Date.now());
    await caches.default.put(base + "epoch", new Response(now, { headers: { "cache-control": "max-age=86400" } }));
    if (env.KV) await env.KV.put("epoch", now);
  } catch (e) {}
}

async function getProgressEpoch(env, cache, base, user) {
  if (!user) return 0;
  var local = 0, remote = 0;
  var lm = await cache.match(base + "pepoch/" + user);
  if (lm) local = parseInt(await lm.text(), 10) || 0;
  if (env.KV) remote = parseInt((await env.KV.get("pepoch:" + user, { cacheTtl: 10 })) || "0", 10) || 0;
  return Math.max(local, remote);
}

async function bumpProgressEpoch(env, request, url, base) {
  try {
    var cred = credential(request, url);
    if (!cred) return;
    var user = userOf(cred) || (await sha16(cred));
    if (!user) return;
    var now = String(Date.now());
    await caches.default.put(base + "pepoch/" + user, new Response(now, { headers: { "cache-control": "max-age=86400" } }));
    if (env.KV) await env.KV.put("pepoch:" + user, now, { expirationTtl: 604800 });
  } catch (e) {}
}

async function store(key, resp, ttl, kind) {
  try {
    if (kind === "html") {
      var ct = (resp.headers.get("content-type") || "").toLowerCase();
      if (ct.indexOf("text/html") === -1 && ct.indexOf("javascript") === -1) return false;
    }
    var h = new Headers(resp.headers);
    h.delete("set-cookie"); h.delete("content-encoding"); h.delete("content-length");
    h.set("x-cached-at", String(Date.now()));
    h.set("cache-control", "max-age=" + ttl);
    applySecurityHeaders(h);
    await caches.default.put(key, new Response(resp.body, { status: 200, headers: h }));
    return true;
  } catch (e) { return false; }
}

function tag(request, hit, label) {
  var notMod = checkNotModified(request, hit.headers, label);
  if (notMod) return notMod;
  var r = new Response(hit.body, hit);
  r.headers.set("x-abs-cache", label);
  r.headers.set("x-abs-probe", (request.cf && request.cf.httpProtocol) || "unknown");
  r.headers.delete("x-cached-at");
  applySecurityHeaders(r.headers);
  return r;
}

async function refresh(request, env, url, key, ttl, kind) {
  try {
    var origin = new URL(env.ORIGIN);
    var r = await fetch(new Request(new URL(url.pathname + url.search, origin).toString(), { method: "GET", headers: request.headers }), { redirect: "manual" });
    if (r.status === 200) await store(key, r, ttl, kind);
    else if (r.status === 401 || r.status === 403 || r.status === 404) await caches.default.delete(key);
  } catch (e) {}
}

async function edgeLookup(request, env, ctx, url, cp, kind) {
  var out = { res: null, fill: null, fallback: null };
  try {
    var jwtMode = isJwtVerifyEnabled(env);
    var isPublicKind = (kind === "asset" || kind === "html" || kind === "rss" || (kind === "cover" && !jwtMode));
    var cred = credential(request, url);
    if (!cred && !isPublicKind) return out;
    var ch = cred ? await sha16(cred) : "";
    var cache = caches.default, base = url.origin + "/__edge/";
    var user = cred ? (userOf(cred) || ch) : "anon";
    var prefix = kind === "cover" ? "c|"
      : (kind === "asset" ? "a|"
      : (kind === "rss" ? "r|"
      : (kind === "html" ? "h|" + url.pathname + "|"
      : (kind === "pjson" ? "pj|" + user + "|" : "j|" + user + "|"))));
    var keyStr = (kind === "html" ? prefix + normQuery(url) : prefix + cp + "|" + normQuery(url));
    var key = base + "d/" + (await sha16(keyStr));
    var fresh = (kind === "cover" || kind === "asset")
      ? num(env.COVER_TTL_S, 2592000)
      : (kind === "html" ? num(env.HTML_FRESH_S, 300)
      : (kind === "rss" ? num(env.RSS_FRESH_S, 300)
      : (kind === "pjson" ? num(env.PJSON_FRESH_S, 60) : num(env.JSON_FRESH_S, 120))));
    var swr = (kind === "cover" || kind === "asset")
      ? 0
      : (kind === "html" ? num(env.HTML_SWR_S, 86400)
      : (kind === "rss" ? num(env.RSS_SWR_S, 3600)
      : (kind === "pjson" ? num(env.PJSON_SWR_S, 600) : num(env.JSON_SWR_S, 3600))));
    out.fill = { key: key, ttl: fresh + swr + 60, kind: kind };
    var parts = await Promise.all([
      isPublicKind ? Promise.resolve(true) : isCredentialValid(env, request, url),
      cache.match(key),
      kind === "asset" ? Promise.resolve(0) : getEpoch(env, cache, base),
      kind === "pjson" ? getProgressEpoch(env, cache, base, user) : Promise.resolve(0)
    ]);
    var valid = parts[0], hit = parts[1], epoch = Math.max(parts[2], parts[3]);
    if (valid && hit) {
      out.fallback = hit;
      var at = parseInt(hit.headers.get("x-cached-at") || "0", 10);
      if (at > epoch) {
        var age = (Date.now() - at) / 1000;
        if (age <= fresh) { out.res = tag(request, hit, "HIT"); return out; }
        if (age <= fresh + swr) {
          ctx.waitUntil(refresh(request, env, url, key, out.fill.ttl, kind));
          out.res = tag(request, hit, "STALE");
          return out;
        }
      }
    }
  } catch (e) { out.res = null; }
  return out;
}

// ---------- audio: session tracking, smart currentTime warming, R2 serving, 9 GB cap ----------

async function listAllObjects(env, prefix) {
  var objects = [], cursor = undefined, listCalls = 0;
  do {
    var opts = {};
    if (prefix) opts.prefix = prefix;
    if (cursor) opts.cursor = cursor;
    listCalls++;
    var res = await env.CACHE.list(opts);
    if (res && Array.isArray(res.objects)) {
      for (var i = 0; i < res.objects.length; i++) objects.push(res.objects[i]);
    }
    cursor = res && res.truncated ? res.cursor : undefined;
  } while (cursor);
  await recordR2Ops(env, listCalls, 0, undefined, false);
  return objects;
}

async function evictItem(env, itemId) {
  try {
    if (!env.CACHE || !itemId) return;
    var r2State = await getR2State(env, false);
    if (r2State.tripped) return;
    var objs = await listAllObjects(env, itemId + "/");
    if (!objs.length) return;
    var keys = objs.map(function (o) { return o.key; });
    for (var i = 0; i < keys.length; i += 1000) {
      await env.CACHE.delete(keys.slice(i, i + 1000));
    }
  } catch (e) {}
}

async function checkProgressEviction(env, request, cp) {
  try {
    if (!env.CACHE) return;
    var m = cp.match(/^\/api\/me\/progress\/([^/]+)$/);
    var body = await request.json();
    if (m && body && body.isFinished === true) {
      await evictItem(env, m[1]);
    } else if (Array.isArray(body)) {
      for (var entry of body) {
        if (entry && entry.isFinished === true && entry.libraryItemId) {
          await evictItem(env, entry.libraryItemId);
        }
      }
    }
  } catch (e) {}
}

async function ensureCapacityFromSnapshot(env, objs, neededBytes, activeItem) {
  var lim = getLimits(env);
  if (!lim.guardEnabled || lim.maxBytes <= 0) {
    var sum = 0;
    for (var o0 of objs) sum += (o0.size || 0);
    return { ok: true, objs: objs, total: sum };
  }
  var maxBytes = lim.maxBytes;
  if (neededBytes <= 0 || neededBytes > maxBytes) return { ok: false, objs: objs, total: 0 };
  var total = 0;
  var byBook = {};
  for (var o of objs) {
    var sz = o.size || 0;
    total += sz;
    var bookId = o.key.split("/")[0] || "";
    if (bookId === activeItem) continue;
    var ts = o.uploaded ? new Date(o.uploaded).getTime() : 0;
    if (!byBook[bookId]) byBook[bookId] = { bookId: bookId, newestTs: ts, size: 0, keys: [] };
    if (ts > byBook[bookId].newestTs) byBook[bookId].newestTs = ts;
    byBook[bookId].size += sz;
    byBook[bookId].keys.push(o.key);
  }
  if (total + neededBytes <= maxBytes) return { ok: true, objs: objs, total: total };

  var books = Object.values(byBook).sort(function (a, b) { return a.newestTs - b.newestTs; });
  var toDelete = [];
  var deletedSet = {};
  var freed = 0;
  for (var b of books) {
    for (var k of b.keys) { toDelete.push(k); deletedSet[k] = true; }
    freed += b.size;
    if (total - freed + neededBytes <= maxBytes) break;
  }

  if (total - freed + neededBytes > maxBytes) {
    return { ok: false, objs: objs, total: total };
  }

  for (var i = 0; i < toDelete.length; i += 1000) {
    await env.CACHE.delete(toDelete.slice(i, i + 1000));
  }
  var remaining = objs.filter(function (o) { return !deletedSet[o.key]; });
  return { ok: true, objs: remaining, total: total - freed };
}

async function enqueueTrackJob(env, job) {
  try {
    if (!env.CACHE || !env.WARM || !job || !job.key) return;
    var r2State = await getR2State(env, false);
    if (r2State.tripped) return;
    var flag = "warm:" + job.key;
    if (env.KV && (await env.KV.get(flag))) return;
    await recordR2Ops(env, 0, 1, undefined, false);
    if (await env.CACHE.head(job.key)) {
      if (env.KV) await env.KV.put(flag, "1", { expirationTtl: 86400 });
      return;
    }
    if (env.KV) await env.KV.put(flag, "1", { expirationTtl: 900 });
    await env.WARM.send(job);
  } catch (e) {}
}

async function warmSlidingWindow(env, sid, sess, currentTrackN, winCount) {
  try {
    if (!env.CACHE || !env.WARM || !sess || !Array.isArray(sess.trackOrder) || winCount <= 0) return;
    var winFlag = "win:" + sid + ":" + currentTrackN;
    if (env.KV && (await env.KV.get(winFlag))) return;
    var idx = sess.trackOrder.indexOf(String(currentTrackN));
    if (idx < 0) return;
    var slice = sess.trackOrder.slice(idx, idx + winCount);
    for (var n of slice) {
      var t = sess.tracks && sess.tracks[n];
      if (!t || !t.key) continue;
      await enqueueTrackJob(env, { sid: sid, item: sess.item, n: String(n), key: t.key, size: t.size || 0, mime: t.mime || "" });
    }
    if (env.KV) await env.KV.put(winFlag, "1", { expirationTtl: 900 });
  } catch (e) {}
}

async function saveItemFileMap(env, itemId, tracksArr, libraryFilesArr) {
  try {
    if (!env.KV || !itemId || !Array.isArray(tracksArr) || !tracksArr.length) return null;
    var inoToIndex = {};
    if (Array.isArray(libraryFilesArr)) {
      for (var lf of libraryFilesArr) {
        if (lf && lf.ino && lf.metadata && lf.metadata.filename) {
          inoToIndex[lf.metadata.filename] = String(lf.ino);
        }
      }
    }
    var byIno = {}, byFile = {};
    for (var i = 0; i < tracksArr.length; i++) {
      var t = tracksArr[i];
      var mm = /\/track\/(\d+)/.exec(t.contentUrl || "");
      var n = mm ? mm[1] : String(t.index != null ? t.index : (i + 1));
      var key = itemId + "/track-" + n;
      var mime = t.mimeType || "";
      var fname = (t.metadata && t.metadata.filename) || "";
      if (!fname && t.contentUrl) {
        var parts = t.contentUrl.split("/");
        fname = decodeURIComponent(parts[parts.length - 1] || "");
      }
      var ino = t.ino ? String(t.ino) : (fname && inoToIndex[fname] ? inoToIndex[fname] : "");
      var entry = { key: key, mime: mime, filename: fname };
      if (ino) byIno[ino] = entry;
      if (fname) byFile[fname] = entry;
    }
    var mapObj = { byIno: byIno, byFile: byFile, count: tracksArr.length };
    await env.KV.put("itemmap:" + itemId, JSON.stringify(mapObj), { expirationTtl: 604800 });
    return mapObj;
  } catch (e) { return null; }
}

async function learnItemDetails(env, resp) {
  try {
    var data = await resp.json();
    if (!data || !data.id || !data.media || !Array.isArray(data.media.tracks)) return;
    await saveItemFileMap(env, data.id, data.media.tracks, data.libraryFiles);
  } catch (e) {}
}

async function learnSessionData(env, s, request, url) {
  try {
    var sid = s && s.id, item = s && s.libraryItemId;
    if (!sid || !item || !Array.isArray(s.audioTracks)) return;
    var cred = request && url ? credential(request, url) : "";
    var tokenHash = cred ? await sha16(cred) : "";
    var userId = String((s && s.userId) || (cred ? userOf(cred) : "") || "");
    if (isJwtVerifyEnabled(env) && cred) {
      var v = await verifyJwtToken(env, cred);
      if (!v.valid) return;
      userId = v.userId || userId;
      tokenHash = v.tokenHash || tokenHash;
    }
    var country = (request && request.cf && request.cf.country) ? String(request.cf.country) : "";
    var curTime = (s && typeof s.currentTime === "number") ? s.currentTime : 0;
    var activeJobIdx = 0;
    var tracks = {}, jobs = [];
    for (var i = 0; i < s.audioTracks.length; i++) {
      var t = s.audioTracks[i];
      var mm = /\/track\/(\d+)/.exec(t.contentUrl || "");
      var n = mm ? mm[1] : String(t.index != null ? t.index : (i + 1));
      var size = (t.metadata && t.metadata.size) || 0;
      var key = item + "/track-" + n;
      var mime = t.mimeType || "";
      var startOff = typeof t.startOffset === "number" ? t.startOffset : 0;
      var dur = typeof t.duration === "number" ? t.duration : 0;
      if (curTime > 0 && curTime >= startOff && (dur <= 0 || curTime < startOff + dur)) {
        activeJobIdx = jobs.length;
      }
      tracks[n] = { key: key, size: size, mime: mime };
      jobs.push({ sid: sid, item: item, n: n, key: key, size: size, mime: mime });
    }
    await env.KV.put("sess:" + sid, JSON.stringify({
      item: item,
      userId: userId,
      tokenHash: tokenHash,
      country: country,
      playerFamily: "",
      closed: false,
      trackOrder: jobs.map(function (j) { return j.n; }),
      tracks: tracks
    }), { expirationTtl: 172800 });
    await saveItemFileMap(env, item, s.audioTracks, s.libraryItem && s.libraryItem.libraryFiles);
    if (env.CACHE && env.WARM) {
      var r2State = await getR2State(env, false);
      if (r2State.tripped) return;
      var lim = getLimits(env);
      var maxBookBytes = num(env.MAX_WARM_MB, 2000) * 1048576;
      if (lim.guardEnabled && lim.maxBytes > 0) maxBookBytes = Math.min(maxBookBytes, lim.maxBytes);
      var total = jobs.reduce(function (a, j) { return a + j.size; }, 0);
      if (total > maxBookBytes) return;
      // Smart Queue Ordering: warm the currently playing track and subsequent chapters FIRST,
      // then wrap around to earlier chapters (bounded by WARM_WINDOW_TRACKS if > 0).
      var prioritized = jobs.slice(activeJobIdx).concat(jobs.slice(0, activeJobIdx));
      var winCount = num(env.WARM_WINDOW_TRACKS, 5);
      var toWarm = (winCount > 0) ? prioritized.slice(0, winCount) : prioritized;
      for (var j of toWarm) {
        await enqueueTrackJob(env, j);
      }
    }
  } catch (e) {}
}

async function learnSession(env, resp, request, url) {
  try {
    var s = await resp.json();
    await learnSessionData(env, s, request, url);
  } catch (e) {}
}

async function closeSessionInKv(env, sid) {
  try {
    if (!env.KV || !sid) return;
    await env.KV.delete("sess:" + sid);
  } catch (e) {}
}

async function ensureSessionLearned(env, request, url, sid) {
  try {
    if (!env.KV || !sid) return;
    if (isJwtVerifyEnabled(env)) {
      var cred = credential(request, url);
      var v = await verifyJwtToken(env, cred);
      if (!v.valid) return;
    }
    var raw = await env.KV.get("sess:" + sid);
    if (raw) {
      var parsed = JSON.parse(raw);
      if (parsed && parsed.tracks && Object.keys(parsed.tracks).length > 0) return;
    }
    var origin = new URL(env.ORIGIN);
    var h = new Headers();
    if (request.headers.get("authorization")) h.set("authorization", request.headers.get("authorization"));
    if (request.headers.get("cookie")) h.set("cookie", request.headers.get("cookie"));
    var r = await fetch(new URL("/api/session/" + sid, origin).toString(), {
      method: "GET",
      headers: h
    });
    if (r.ok) {
      await learnSessionData(env, await r.json(), request, url);
    }
  } catch (e) {}
}

async function buildR2TrackResponse(request, env, ctx, t, isDownload) {
  if (request.method === "HEAD") {
    ctx.waitUntil(recordR2Ops(env, 0, 1, undefined, false));
    var h = await env.CACHE.head(t.key);
    if (!h) return null;
    var hh = new Headers();
    h.writeHttpMetadata(hh);
    hh.set("content-length", String(h.size));
    hh.set("accept-ranges", "bytes");
    hh.set("etag", h.httpEtag);
    hh.set("x-abs-cache", "HIT");
    hh.set("x-abs-probe", (request.cf && request.cf.httpProtocol) || "unknown");
    if (t.mime) hh.set("content-type", t.mime);
    if (isDownload && t.filename) {
      hh.set("content-disposition", 'attachment; filename="' + t.filename.replace(/"/g, "") + '"');
    }
    applySecurityHeaders(hh);
    var notModHead = checkNotModified(request, hh, "HIT");
    if (notModHead) return notModHead;
    return new Response(null, { status: 200, headers: hh });
  }
  var rangeHdr = request.headers.get("range");
  ctx.waitUntil(recordR2Ops(env, 0, 1, undefined, false));
  var obj = await env.CACHE.get(t.key, rangeHdr ? { range: request.headers } : {});
  if (!obj) return null;
  var headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set("x-abs-cache", "HIT");
  headers.set("x-abs-probe", (request.cf && request.cf.httpProtocol) || "unknown");
  if (t.mime) headers.set("content-type", t.mime);
  if (isDownload && t.filename) {
    headers.set("content-disposition", 'attachment; filename="' + t.filename.replace(/"/g, "") + '"');
  }
  applySecurityHeaders(headers);
  var notMod = checkNotModified(request, headers, "HIT");
  if (notMod) return notMod;
  var status = 200;
  if (rangeHdr && obj.range) {
    var r = obj.range, off, len;
    if (r.suffix !== undefined) { len = Math.min(r.suffix, obj.size); off = obj.size - len; }
    else { off = r.offset || 0; len = r.length !== undefined ? r.length : obj.size - off; }
    headers.set("content-range", "bytes " + off + "-" + (off + len - 1) + "/" + obj.size);
    headers.set("content-length", String(len));
    status = 206;
  } else {
    headers.set("content-length", String(obj.size));
  }
  return new Response(obj.body, { status: status, headers: headers });
}

async function serveFromCache(request, env, ctx, url, sid, n) {
  try {
    var r2State = await getR2State(env, false);
    if (r2State.tripped) return { hit: null, bypassed: true, forbidden: false };
    var raw = await env.KV.get("sess:" + sid);
    if (!raw) return { hit: null, bypassed: false, forbidden: false };
    var sess = JSON.parse(raw);
    if (sess.closed) return { hit: null, bypassed: false, forbidden: false };

    if (sess.tokenHash && env.KV) {
      var rev = await env.KV.get("revoked:" + sess.tokenHash, { cacheTtl: 60 });
      if (rev) return { hit: null, bypassed: false, forbidden: true };
    }

    // Device-Platform & Geo-Country Lock (prevents cross-country / cross-OS replay of leaked session URLs
    // while allowing seamless Wi-Fi <-> cellular handoffs on the same device)
    if (isSessionLockEnabled(env)) {
      var reqCountry = (request.cf && request.cf.country) ? String(request.cf.country) : "";
      if (sess.country && reqCountry && sess.country !== reqCountry) {
        return { hit: null, bypassed: false, forbidden: true };
      }
      var reqFam = detectPlayerFamily(request.headers.get("user-agent") || "");
      if (!sess.playerFamily && reqFam !== "unknown") {
        sess.playerFamily = reqFam;
        ctx.waitUntil(env.KV.put("sess:" + sid, JSON.stringify(sess), { expirationTtl: 172800 }));
      } else if (sess.playerFamily && reqFam !== "unknown" && sess.playerFamily !== reqFam) {
        return { hit: null, bypassed: false, forbidden: true };
      }
    }

    var cred = credential(request, url);
    if (isJwtVerifyEnabled(env) && cred) {
      var v = await verifyJwtToken(env, cred);
      if (!v.valid) return { hit: null, bypassed: false, forbidden: true };
      if (sess.userId && v.userId && sess.userId !== v.userId) {
        return { hit: null, bypassed: false, forbidden: true };
      }
    }

    var t = (sess.tracks && sess.tracks[n]) || (sess.item ? { key: sess.item + "/track-" + n, size: 0, mime: "" } : null);
    if (!t) return { hit: null, bypassed: false, forbidden: false };
    var winCount = num(env.WARM_WINDOW_TRACKS, 5);
    if (winCount > 0 && Array.isArray(sess.trackOrder) && env.WARM && env.CACHE) {
      ctx.waitUntil(warmSlidingWindow(env, sid, sess, String(n), winCount));
    }
    var resp = await buildR2TrackResponse(request, env, ctx, t, false);
    if (!resp) {
      ctx.waitUntil(enqueueTrackJob(env, { sid: sid, item: sess.item, n: String(n), key: t.key, size: t.size || 0, mime: t.mime || "" }));
      return { hit: null, bypassed: false, forbidden: false };
    }
    return { hit: resp, bypassed: false, forbidden: false };
  } catch (e) { return { hit: null, bypassed: false, forbidden: false }; }
}

async function serveDownloadFromCacheIfPresent(request, env, ctx, url, itemId, ino, filename, isExplicitDownload) {
  try {
    var r2State = await getR2State(env, false);
    if (r2State.tripped) return null;
    if (!(await isCredentialValid(env, request, url))) return null;

    var rawMap = await env.KV.get("itemmap:" + itemId);
    var mapObj = rawMap ? JSON.parse(rawMap) : null;

    if (!mapObj || (ino && (!mapObj.byIno || !mapObj.byIno[ino])) || (filename && (!mapObj.byFile || !mapObj.byFile[filename]))) {
      ctx.waitUntil(recordR2Ops(env, 0, 1, undefined, false));
      var hasTrack1 = await env.CACHE.head(itemId + "/track-1");
      if (!hasTrack1) return null;

      var origin = new URL(env.ORIGIN);
      var h = new Headers();
      var cred = credential(request, url);
      if (cred) h.set("authorization", "Bearer " + cred);
      if (request.headers.get("cookie")) h.set("cookie", request.headers.get("cookie"));
      var r = await fetch(new URL("/api/items/" + itemId, origin).toString(), { method: "GET", headers: h });
      if (r.ok) {
        var itemData = await r.json();
        if (itemData && itemData.media && Array.isArray(itemData.media.tracks)) {
          mapObj = await saveItemFileMap(env, itemId, itemData.media.tracks, itemData.libraryFiles);
        }
      }
    }

    if (!mapObj) return null;
    var t = null;
    if (ino && mapObj.byIno && mapObj.byIno[ino]) t = mapObj.byIno[ino];
    else if (filename && mapObj.byFile && mapObj.byFile[filename]) t = mapObj.byFile[filename];
    else if (mapObj.count === 1) t = { key: itemId + "/track-1", mime: "", filename: filename || "" };
    if (!t) return null;

    return await buildR2TrackResponse(request, env, ctx, t, isExplicitDownload);
  } catch (e) { return null; }
}

async function serveRssAudioFromCache(request, env, ctx, cp, slug, restPath) {
  try {
    var r2State = await getR2State(env, false);
    if (r2State.tripped) return { hit: null, bypassed: true };
    var key = "rss/" + slug + "/" + (await sha16(restPath));
    var resp = await buildR2TrackResponse(request, env, ctx, { key: key, mime: "" }, false);
    if (!resp) {
      ctx.waitUntil(enqueueTrackJob(env, { type: "rss-track", item: "rss-" + slug, path: cp, key: key }));
      return { hit: null, bypassed: false };
    }
    return { hit: resp, bypassed: false };
  } catch (e) { return { hit: null, bypassed: false }; }
}

async function queueOfflineProgressWrite(env, request, url, cp, bodyText) {
  try {
    if (!env.WARM) return false;
    if (!(await isCredentialValid(env, request, url))) return false;
    var fwdHeaders = {};
    if (request.headers.get("authorization")) fwdHeaders["authorization"] = request.headers.get("authorization");
    if (request.headers.get("cookie")) fwdHeaders["cookie"] = request.headers.get("cookie");
    if (request.headers.get("content-type")) fwdHeaders["content-type"] = request.headers.get("content-type");
    await env.WARM.send({
      type: "progress",
      method: request.method,
      pathWithSearch: url.pathname + url.search,
      headers: fwdHeaders,
      body: bodyText,
      queuedAt: Date.now()
    });
    await bumpProgressEpoch(env, request, url, url.origin + "/__edge/");
    return true;
  } catch (e) { return false; }
}

async function handleFetch(request, env, ctx) {
    var url = new URL(request.url);
    var p = url.pathname;
    if (BLOCK_DOT.test(p) || BLOCK_PATH.test(p) || BLOCK_EXT.test(p)) {
      return new Response("Not found", { status: 404 });
    }
    var cp = stripBase(p);
    var origin = new URL(env.ORIGIN);

    // Edge Brute-Force Login Rate Limiter (5 failed attempts -> 15 min block at edge)
    var isLoginPost = (request.method === "POST" && (/^\/login(\/|$)/.test(cp) || /^\/api\/login(\/|$)/.test(cp)));
    var loginCheck = isLoginPost ? await checkLoginRateLimit(env, request, url) : null;
    if (loginCheck && loginCheck.blocked) {
      var rlHeaders = new Headers({ "content-type": "application/json", "retry-after": "900" });
      applySecurityHeaders(rlHeaders);
      return new Response(JSON.stringify({ error: "Too many failed login attempts. Please try again in 15 minutes." }), {
        status: 429,
        headers: rlHeaders
      });
    }

    if (cp === "/__abs-cache/status" && request.method === "GET") {
      if (!(await isCredentialValid(env, request, url))) return new Response("Unauthorized", { status: 401 });
      var st = await getR2State(env, true);
      var lim = getLimits(env);
      var stHeaders = new Headers({ "content-type": "application/json" });
      applySecurityHeaders(stHeaders);
      return new Response(JSON.stringify({
        month: monthKey().replace("r2:usage:", ""),
        freeTierGuard: lim.guardEnabled ? "yes" : "no",
        verifyJwt: isJwtVerifyEnabled(env) ? "yes" : "no",
        sessionLock: isSessionLockEnabled(env) ? "yes" : "no",
        circuitBreakerTripped: st.tripped,
        reason: st.reason || (lim.guardEnabled ? "OK (within Free Tier safety limits)" : "FREE_TIER_GUARD=no (kill switches disabled)"),
        storage: lim.guardEnabled ? {
          currentBytes: st.bytes,
          currentMB: Math.round((st.bytes / 1000000) * 100) / 100,
          maxBytes: lim.maxBytes,
          maxMB: Math.round(lim.maxBytes / 1000000),
          percentUsed: Math.round((st.bytes / lim.maxBytes) * 10000) / 100
        } : "unlimited",
        classAOps: lim.guardEnabled ? { used: st.a + pendingClassA, max: lim.maxClassA, freeTier: 1000000 } : "unlimited",
        classBOps: lim.guardEnabled ? { used: st.b + pendingClassB, max: lim.maxClassB, freeTier: 10000000 } : "unlimited"
      }, null, 2), { status: 200, headers: stHeaders });
    }

    // 1. Active session audio streaming (/public/session/:sid/track/:n): serves from R2 and warms on miss
    var m = cp.match(/^\/public\/session\/([^/]+)\/track\/(\d+)$/);
    var r2Bypassed = false;
    if (m && env.CACHE && env.KV && (request.method === "GET" || request.method === "HEAD")) {
      var res = await serveFromCache(request, env, ctx, url, m[1], m[2]);
      if (res.forbidden) {
        var fbHeaders = new Headers({ "x-abs-cache": "BLOCKED-SESSION-LOCK" });
        applySecurityHeaders(fbHeaders);
        return new Response("Forbidden: session locked to originating device/user", { status: 403, headers: fbHeaders });
      }
      if (res.hit) { ctx.waitUntil(record(env, request, res.hit, url, cp)); return res.hit; }
      r2Bypassed = res.bypassed;
    }

    // 2. Direct file / offline download requests (/api/items/:id/file/:ino[/download] or /s/item/:id/:file):
    //    Serves from R2 if ALREADY cached, but NEVER stores/warms into R2 on a miss!
    var dlIno = cp.match(/^\/api\/items\/([^/]+)\/file\/([^/]+)(\/download)?$/);
    var dlFile = !dlIno ? cp.match(/^\/s\/item\/([^/]+)\/(.+)$/) : null;
    if ((dlIno || dlFile) && env.CACHE && env.KV && (request.method === "GET" || request.method === "HEAD")) {
      var dlItemId = dlIno ? dlIno[1] : dlFile[1];
      var ino = dlIno ? dlIno[2] : "";
      var fname = dlFile ? decodeURIComponent(dlFile[2]) : "";
      var isExplicitDl = Boolean(dlIno && dlIno[3]);
      var dlHit = await serveDownloadFromCacheIfPresent(request, env, ctx, url, dlItemId, ino, fname, isExplicitDl);
      if (dlHit) { ctx.waitUntil(record(env, request, dlHit, url, cp)); return dlHit; }
    }

    // 3. RSS Feed Audio Enclosures (/feed/:slug/:file...): serves from R2 and warms on miss
    var rssAudio = cp.match(/^\/feed\/([^/]+)\/(.+)$/);
    if (rssAudio && env.CACHE && (request.method === "GET" || request.method === "HEAD")) {
      var rssRes = await serveRssAudioFromCache(request, env, ctx, cp, rssAudio[1], rssAudio[2]);
      if (rssRes.hit) { ctx.waitUntil(record(env, request, rssRes.hit, url, cp)); return rssRes.hit; }
      if (rssRes.bypassed) r2Bypassed = true;
    }

    var lookup = null;
    if (request.method === "GET" && env.EDGE_CACHE !== "off" && !request.headers.has("range")) {
      var kind = classify(cp, url.search, request);
      if (kind) {
        lookup = await edgeLookup(request, env, ctx, url, cp, kind);
        if (lookup.res) { ctx.waitUntil(record(env, request, lookup.res, url, cp)); return lookup.res; }
      }
    }

    var reqCloneForProgress = (request.method === "PATCH" && env.CACHE && /^\/api\/me\/progress(\/[^/]+)?$/.test(cp))
      ? request.clone()
      : null;

    var syncMatch = (request.method === "POST" && env.KV)
      ? cp.match(/^\/api\/session\/([^/]+)\/sync$/)
      : null;
    if (syncMatch) {
      ctx.waitUntil(ensureSessionLearned(env, request.clone(), url, syncMatch[1]));
    }

    var closeMatch = (request.method === "POST" && env.KV)
      ? cp.match(/^\/api\/session\/([^/]+)\/close$/)
      : null;

    var isLogout = (request.method === "POST" && (/^\/logout(\/|$)/.test(cp) || /^\/api\/logout(\/|$)/.test(cp)));

    var isProgressWrite = (request.method === "POST" || request.method === "PATCH") && OFFLINE_PROGRESS_QUEUE_RE.test(cp);
    var reqCloneForOffline = isProgressWrite ? request.clone() : null;

    var target = new URL(p + url.search, origin);
    var resp = null;
    var fetchErr = null;
    try {
      resp = await fetch(new Request(target.toString(), request), { redirect: "manual" });
    } catch (e) {
      fetchErr = e;
    }

    if (fetchErr || (resp && isOriginDownStatus(resp.status))) {
      if (lookup && lookup.fallback) {
        var sie = tag(request, lookup.fallback, "STALE-IF-ERROR");
        ctx.waitUntil(record(env, request, sie, url, cp));
        return sie;
      }
      if (isProgressWrite && reqCloneForOffline && env.WARM) {
        var bodyText = "";
        try { bodyText = await reqCloneForOffline.text(); } catch (e) {}
        var queued = await queueOfflineProgressWrite(env, request, url, cp, bodyText);
        if (queued) {
          if (closeMatch) ctx.waitUntil(closeSessionInKv(env, closeMatch[1]));
          var qHeaders = new Headers({ "content-type": "application/json", "x-abs-cache": "QUEUED-OFFLINE" });
          qHeaders.set("x-abs-probe", (request.cf && request.cf.httpProtocol) || "unknown");
          applySecurityHeaders(qHeaders);
          var qResp = new Response(JSON.stringify({ offlineQueued: true }), { status: 200, headers: qHeaders });
          ctx.waitUntil(record(env, request, qResp, url, cp));
          return qResp;
        }
      }
      if (fetchErr) {
        var errH = new Headers({ "content-type": "application/json", "x-abs-cache": "ORIGIN-OFFLINE" });
        applySecurityHeaders(errH);
        return new Response(JSON.stringify({ error: "Origin unreachable" }), { status: 502, headers: errH });
      }
    }

    if (isLoginPost && loginCheck) {
      ctx.waitUntil(recordLoginResult(env, url, loginCheck.ip, resp.ok));
    }

    if (isLogout) {
      ctx.waitUntil(revokeToken(env, request, url));
    } else if ((cp.indexOf("/api/") === 0 || cp.indexOf("/s/") === 0) && (resp.status === 401 || resp.status === 403)) {
      ctx.waitUntil((async function () {
        try {
          var c = credential(request, url);
          if (c) await caches.default.delete(url.origin + "/__edge/v/" + (await sha16(c)));
        } catch (e) {}
      })());
    }
    if (closeMatch && resp.ok) {
      ctx.waitUntil(closeSessionInKv(env, closeMatch[1]));
    }
    if (reqCloneForProgress && resp.ok) {
      ctx.waitUntil(checkProgressEviction(env, reqCloneForProgress, cp));
    }
    if (request.method === "POST" && env.KV && resp.ok && /^\/api\/items\/[^/]+\/play(\/[^/]+)?$/.test(cp)) {
      ctx.waitUntil(learnSession(env, resp.clone(), request, url));
    }
    if (request.method === "GET" && env.KV && resp.status === 200 && /^\/api\/items\/[^/]+$/.test(cp)) {
      ctx.waitUntil(learnItemDetails(env, resp.clone()));
    }
    // Bump per-user progress epoch whenever listening progress or session state mutates
    if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS"
        && resp.status < 400 && PROGRESS_WRITE_RE.test(cp)) {
      ctx.waitUntil(bumpProgressEpoch(env, request, url, url.origin + "/__edge/"));
    }
    if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS"
        && cp.indexOf("/api/") === 0 && resp.status < 400 && !NOBUMP.test(cp)) {
      ctx.waitUntil(bumpEpoch(env, url.origin + "/__edge/"));
    }
    if (cp.indexOf("/api/") === 0 && resp.status >= 200 && resp.status < 300 && !isLogout) {
      ctx.waitUntil(markValid(env, request, url));
    }
    var filled = false;
    if (lookup && lookup.fill && resp.status === 200) {
      if (lookup.fill.kind === "html") {
        var ct = (resp.headers.get("content-type") || "").toLowerCase();
        if (ct.indexOf("text/html") !== -1 || ct.indexOf("javascript") !== -1) {
          ctx.waitUntil(store(lookup.fill.key, resp.clone(), lookup.fill.ttl, lookup.fill.kind));
          filled = true;
        }
      } else {
        ctx.waitUntil(store(lookup.fill.key, resp.clone(), lookup.fill.ttl, lookup.fill.kind));
        filled = true;
      }
    }

    if (resp.status === 101) { ctx.waitUntil(record(env, request, resp, url, cp)); return resp; }
    var out = new Response(resp.body, resp);
    var loc = out.headers.get("location");
    if (loc) {
      try {
        var l = new URL(loc, origin);
        if (l.host === origin.host) { l.host = url.host; out.headers.set("location", l.toString()); }
      } catch (e) {}
    }
    out.headers.set("x-abs-probe", (request.cf && request.cf.httpProtocol) || "unknown");
    if (r2Bypassed) out.headers.set("x-abs-cache", "BYPASS-LIMIT");
    else if (m || filled) out.headers.set("x-abs-cache", "MISS");
    else if (dlIno || dlFile) out.headers.set("x-abs-cache", "MISS-NO-STORE");
    applySecurityHeaders(out.headers);
    ctx.waitUntil(record(env, request, out, url, cp));
    return out;
}

export default {
  async fetch(request, env, ctx) {
    var failOpenReq = request.clone();
    try {
      return await handleFetch(request, env, ctx);
    } catch (e) {
      try {
        var url = new URL(failOpenReq.url);
        var origin = new URL(env.ORIGIN);
        var resp = await fetch(new Request(new URL(url.pathname + url.search, origin).toString(), failOpenReq), { redirect: "manual" });
        var out = new Response(resp.body, resp);
        out.headers.set("x-abs-cache", "FAIL-OPEN");
        applySecurityHeaders(out.headers);
        return out;
      } catch (e2) {
        return new Response("Origin unreachable", { status: 502 });
      }
    }
  },

  async queue(batch, env) {
    var r2State = await getR2State(env, true);
    var r2Skip = (!env.CACHE || r2State.tripped);
    var lim = getLimits(env);
    var snapshot = [];
    var existingKeys = {};
    var currentTotal = 0;
    if (lim.guardEnabled && !r2Skip) {
      snapshot = await listAllObjects(env);
      for (var o of snapshot) {
        existingKeys[o.key] = true;
        currentTotal += (o.size || 0);
      }
    }

    for (var msg of batch.messages) {
      var j = msg.body;
      try {
        if (j && j.type === "progress") {
          var pOrigin = new URL(env.ORIGIN);
          var pResp = await fetch(new URL(j.pathWithSearch, pOrigin).toString(), {
            method: j.method || "POST",
            headers: j.headers || {},
            body: j.body || undefined
          });
          if (pResp.ok || (pResp.status >= 400 && pResp.status < 500)) {
            msg.ack();
          } else {
            msg.retry();
          }
          continue;
        }
        if (r2Skip) { msg.ack(); continue; }
        var stateNow = await getR2State(env, false);
        if (stateNow.tripped) { msg.ack(); continue; }
        if (!j || !j.key || existingKeys[j.key]) { msg.ack(); continue; }
        if (!lim.guardEnabled && (await env.CACHE.head(j.key))) { msg.ack(); continue; }
        var activeItem = j.item || j.key.split("/")[0] || "";
        var origin = new URL(env.ORIGIN);
        var originPath = (j.type === "rss-track" && j.path) ? j.path : ("/public/session/" + j.sid + "/track/" + j.n);
        var r = await fetch(new URL(originPath, origin).toString());
        if (r.status === 404 || r.status === 401 || r.status === 403) {
          if (env.KV) await env.KV.delete("warm:" + j.key);
          msg.ack();
          continue;
        }
        var len = parseInt(r.headers.get("content-length") || "0", 10);
        if (!r.ok || !r.body || !len) { msg.retry(); continue; }
        var maxBookBytes = num(env.MAX_WARM_MB, 2000) * 1048576;
        if (lim.guardEnabled && lim.maxBytes > 0) maxBookBytes = Math.min(maxBookBytes, lim.maxBytes);
        if (len > maxBookBytes) {
          if (env.KV) await env.KV.delete("warm:" + j.key);
          msg.ack();
          continue;
        }
        if (lim.guardEnabled) {
          var cap = await ensureCapacityFromSnapshot(env, snapshot, len, activeItem);
          snapshot = cap.objs;
          currentTotal = cap.total;
          if (!cap.ok) {
            if (env.KV) await env.KV.delete("warm:" + j.key);
            msg.ack();
            continue;
          }
        }
        var fls = new FixedLengthStream(len);
        var pipe = r.body.pipeTo(fls.writable);
        await env.CACHE.put(j.key, fls.readable, {
          httpMetadata: { contentType: j.mime || r.headers.get("content-type") || "audio/mpeg" }
        });
        await pipe;
        currentTotal += len;
        existingKeys[j.key] = true;
        if (lim.guardEnabled) snapshot.push({ key: j.key, size: len, uploaded: new Date().toISOString() });
        if (env.KV) await env.KV.put("warm:" + j.key, "1", { expirationTtl: 86400 });
        await recordR2Ops(env, 1, 0, currentTotal, false);
        msg.ack();
      } catch (e) { msg.retry(); }
    }
    if (lim.guardEnabled && !r2Skip) await recordR2Ops(env, 0, 0, currentTotal, true);
  }
};