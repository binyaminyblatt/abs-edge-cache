// abs-edge-cache: Cloudflare Worker front door for Audiobookshelf
// - blocks scanner/bot paths, proxies everything else to ORIGIN (supports root and /audiobookshelf base path)
// - edge-caches Web UI HTML shell, CSS, JS (_nuxt/*), fonts, icons, book covers, and static metadata
// - learns playback sessions, serves cached audio from R2, warms cache via Queue ONLY on active playback
// - accelerates offline book downloads (/api/items/:id/file/:ino, /s/item/:id/:file) from R2 if ALREADY cached,
//   without warming/storing downloaded books into R2 on a miss
// - optional Free-Tier R2 Circuit Breaker (FREE_TIER_GUARD = "yes" by default; set to "no" for unlimited paid R2)

const ID_RE = /^(li|ses|usr|lib|ser|aut|col|pl|ep|fol|dev)_[a-z0-9]+$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILE_RE = /\.(mp3|m4b|m4a|flac|ogg|opus|aac|wav|jpg|jpeg|png|webp|m3u8|ts|m4s|mp4|epub|pdf)$/i;
const BLOCK_DOT = /\/\.(?!well-known\/)/;
const BLOCK_PATH = /^\/(actuator|_vti|wp-|wordpress|phpmyadmin|cgi-bin|server-status|vendor\/|xmlrpc|boaform|HNAP1|ecp\/|owa\/|solr\/|jenkins|manager\/html)/i;
const BLOCK_EXT = /\.(php\d?|aspx?|jsp|cgi|sql|bak|ini|ya?ml|conf|env|git|log|swp|tar|gz|zip)$/i;
const APP_PATH = /^\/(api|public|s|hls|socket\.io|login|logout|status|ping|auth|feed|_nuxt)(\/|$)/;
const NOBUMP = /^\/api\/(session|me|authorize|items\/[^/]+\/play)(\/|$)/;
const STATIC_ASSET_RE = /^\/_nuxt\/.+|\.(css|js|mjs|woff2?|ttf|otf|eot|svg|ico|webp|png|jpg|jpeg|gif|webmanifest|map)$/i;
const NON_HTML_PREFIX = /^\/(api|public|s|hls|socket\.io|auth|feed|logout|status|ping)(\/|$)/;

const DEFAULT_MAX_BUCKET_BYTES = 9000000000;
const DEFAULT_MAX_CLASS_A = 800000;
const DEFAULT_MAX_CLASS_B = 8000000;

var pendingClassA = 0;
var pendingClassB = 0;
var cachedBreakerState = null;
var cachedBreakerAt = 0;

function num(v, d) { var n = parseInt(v, 10); return isNaN(n) ? d : n; }

function isFreeTierGuardEnabled(env) {
  var v = String(env.FREE_TIER_GUARD === undefined ? "yes" : env.FREE_TIER_GUARD).trim().toLowerCase();
  return !(v === "no" || v === "false" || v === "off" || v === "0");
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
  if (env.R2_DISABLED === "true" || env.R2_DISABLED === "1" || env.R2_DISABLED === "yes") {
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

// ---------- edge cache for Web UI assets (HTML/CSS/JS), covers & static metadata ----------

async function sha16(s) {
  var d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).slice(0, 8).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
}

function credential(request, url) {
  var a = request.headers.get("authorization");
  if (a && /^Bearer /i.test(a)) return a.slice(7).trim();
  return url.searchParams.get("token") || "";
}

function userOf(cred) {
  try {
    var p = cred.split(".");
    if (p.length === 3) {
      var j = JSON.parse(atob(p[1].replace(/-/g, "+").replace(/_/g, "/")));
      return String(j.userId || j.id || j.sub || "");
    }
  } catch (e) {}
  return "";
}

function normQuery(url) {
  var ps = [];
  url.searchParams.forEach(function (v, k) { if (k !== "token") ps.push(k + "=" + v); });
  ps.sort();
  return ps.join("&");
}

function classify(cp, search, request) {
  if (/^\/api\/items\/[^/]+\/cover$/.test(cp) || /^\/api\/authors\/[^/]+\/image$/.test(cp)) return "cover";
  if (cp.indexOf("/api/") !== 0 && !NON_HTML_PREFIX.test(cp)) {
    if (cp === "/sw.js") return "html"; // Service worker gets short HTML-like fresh+SWR window
    if (STATIC_ASSET_RE.test(cp)) return "asset";
    var accept = request.headers.get("accept") || "";
    if (accept.indexOf("text/html") !== -1) return "html";
  }
  if (/progress|rssfeed/i.test(search)) return null;
  if (/^\/api\/libraries$/.test(cp)
    || /^\/api\/libraries\/[^/]+(\/(items|series|authors|collections|filterdata|stats))?$/.test(cp)
    || /^\/api\/items\/[^/]+$/.test(cp)
    || /^\/api\/authors\/[^/]+$/.test(cp)
    || /^\/api\/series\/[^/]+$/.test(cp)
    || /^\/api\/collections(\/[^/]+)?$/.test(cp)) return "json";
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
    await caches.default.put(key, new Response(resp.body, { status: 200, headers: h }));
    return true;
  } catch (e) { return false; }
}

function tag(hit, label) {
  var r = new Response(hit.body, hit);
  r.headers.set("x-abs-cache", label);
  r.headers.delete("x-cached-at");
  return r;
}

async function markValid(request, url) {
  try {
    var cred = credential(request, url);
    if (!cred) return;
    var k = url.origin + "/__edge/v/" + (await sha16(cred));
    if (await caches.default.match(k)) return;
    await caches.default.put(k, new Response("1", { headers: { "cache-control": "max-age=900" } }));
  } catch (e) {}
}

async function isCredentialValid(request, url) {
  var cred = credential(request, url);
  if (!cred) return false;
  var k = url.origin + "/__edge/v/" + (await sha16(cred));
  return Boolean(await caches.default.match(k));
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
  var out = { res: null, fill: null };
  try {
    var isPublicKind = (kind === "cover" || kind === "asset" || kind === "html");
    var cred = credential(request, url);
    if (!cred && !isPublicKind) return out;
    var ch = cred ? await sha16(cred) : "";
    var cache = caches.default, base = url.origin + "/__edge/";
    var user = cred ? (userOf(cred) || ch) : "anon";
    var prefix = kind === "cover" ? "c|" : (kind === "asset" ? "a|" : (kind === "html" ? "h|" + url.pathname + "|" : "j|" + user + "|"));
    // Note: for HTML shell, key by actual url.pathname (since base path / vs /audiobookshelf/ affects asset links in HTML)
    var keyStr = (kind === "html" ? prefix + normQuery(url) : prefix + cp + "|" + normQuery(url));
    var key = base + "d/" + (await sha16(keyStr));
    var fresh = (kind === "cover" || kind === "asset")
      ? num(env.COVER_TTL_S, 2592000)
      : (kind === "html" ? num(env.HTML_FRESH_S, 300) : num(env.JSON_FRESH_S, 120));
    var swr = (kind === "cover" || kind === "asset")
      ? 0
      : (kind === "html" ? num(env.HTML_SWR_S, 86400) : num(env.JSON_SWR_S, 3600));
    out.fill = { key: key, ttl: fresh + swr + 60, kind: kind };
    var parts = await Promise.all([
      (cred && !isPublicKind) ? cache.match(base + "v/" + ch) : Promise.resolve(true),
      cache.match(key),
      kind === "asset" ? Promise.resolve(0) : getEpoch(env, cache, base)
    ]);
    var valid = parts[0], hit = parts[1], epoch = parts[2];
    if (valid && hit) {
      var at = parseInt(hit.headers.get("x-cached-at") || "0", 10);
      if (at > epoch) {
        var age = (Date.now() - at) / 1000;
        if (age <= fresh) { out.res = tag(hit, "HIT"); return out; }
        if (age <= fresh + swr) {
          ctx.waitUntil(refresh(request, env, url, key, out.fill.ttl, kind));
          out.res = tag(hit, "STALE");
          return out;
        }
      }
    }
  } catch (e) { out.res = null; }
  return out;
}

// ---------- audio: session tracking, R2 serving, 9 GB cap, circuit breaker ----------

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

async function learnSessionData(env, s) {
  try {
    var sid = s && s.id, item = s && s.libraryItemId;
    if (!sid || !item || !Array.isArray(s.audioTracks)) return;
    var tracks = {}, jobs = [];
    for (var i = 0; i < s.audioTracks.length; i++) {
      var t = s.audioTracks[i];
      var mm = /\/track\/(\d+)/.exec(t.contentUrl || "");
      var n = mm ? mm[1] : String(t.index != null ? t.index : (i + 1));
      var size = (t.metadata && t.metadata.size) || 0;
      var key = item + "/track-" + n;
      var mime = t.mimeType || "";
      tracks[n] = { key: key, size: size, mime: mime };
      jobs.push({ sid: sid, item: item, n: n, key: key, size: size, mime: mime });
    }
    await env.KV.put("sess:" + sid, JSON.stringify({ item: item, tracks: tracks }), { expirationTtl: 172800 });
    await saveItemFileMap(env, item, s.audioTracks, s.libraryItem && s.libraryItem.libraryFiles);
    if (env.CACHE && env.WARM) {
      var r2State = await getR2State(env, false);
      if (r2State.tripped) return;
      var lim = getLimits(env);
      var maxBookBytes = num(env.MAX_WARM_MB, 2000) * 1048576;
      if (lim.guardEnabled && lim.maxBytes > 0) maxBookBytes = Math.min(maxBookBytes, lim.maxBytes);
      var total = jobs.reduce(function (a, j) { return a + j.size; }, 0);
      if (total > maxBookBytes) return;
      for (var j of jobs) {
        await enqueueTrackJob(env, j);
      }
    }
  } catch (e) {}
}

async function learnSession(env, resp) {
  try {
    var s = await resp.json();
    await learnSessionData(env, s);
  } catch (e) {}
}

async function ensureSessionLearned(env, request, sid) {
  try {
    if (!env.KV || !sid) return;
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
      await learnSessionData(env, await r.json());
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
    if (t.mime) hh.set("content-type", t.mime);
    if (isDownload && t.filename) {
      hh.set("content-disposition", 'attachment; filename="' + t.filename.replace(/"/g, "") + '"');
    }
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
  if (t.mime) headers.set("content-type", t.mime);
  if (isDownload && t.filename) {
    headers.set("content-disposition", 'attachment; filename="' + t.filename.replace(/"/g, "") + '"');
  }
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

async function serveFromCache(request, env, ctx, sid, n) {
  try {
    var r2State = await getR2State(env, false);
    if (r2State.tripped) return { hit: null, bypassed: true };
    var raw = await env.KV.get("sess:" + sid);
    if (!raw) return { hit: null, bypassed: false };
    var sess = JSON.parse(raw);
    var t = (sess.tracks && sess.tracks[n]) || (sess.item ? { key: sess.item + "/track-" + n, size: 0, mime: "" } : null);
    if (!t) return { hit: null, bypassed: false };
    var resp = await buildR2TrackResponse(request, env, ctx, t, false);
    if (!resp) {
      ctx.waitUntil(enqueueTrackJob(env, { sid: sid, item: sess.item, n: String(n), key: t.key, size: t.size || 0, mime: t.mime || "" }));
      return { hit: null, bypassed: false };
    }
    return { hit: resp, bypassed: false };
  } catch (e) { return { hit: null, bypassed: false }; }
}

async function serveDownloadFromCacheIfPresent(request, env, ctx, url, itemId, ino, filename, isExplicitDownload) {
  try {
    var r2State = await getR2State(env, false);
    if (r2State.tripped) return null;
    if (!(await isCredentialValid(request, url))) return null;

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

export default {
  async fetch(request, env, ctx) {
    var url = new URL(request.url);
    var p = url.pathname;
    if (BLOCK_DOT.test(p) || BLOCK_PATH.test(p) || BLOCK_EXT.test(p)) {
      return new Response("Not found", { status: 404 });
    }
    var cp = stripBase(p);
    var origin = new URL(env.ORIGIN);

    if (cp === "/__abs-cache/status" && request.method === "GET") {
      if (!(await isCredentialValid(request, url))) return new Response("Unauthorized", { status: 401 });
      var st = await getR2State(env, true);
      var lim = getLimits(env);
      return new Response(JSON.stringify({
        month: monthKey().replace("r2:usage:", ""),
        freeTierGuard: lim.guardEnabled ? "yes" : "no",
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
      }, null, 2), { status: 200, headers: { "content-type": "application/json" } });
    }

    // 1. Active session audio streaming (/public/session/:sid/track/:n): serves from R2 and warms on miss
    var m = cp.match(/^\/public\/session\/([^/]+)\/track\/(\d+)$/);
    var r2Bypassed = false;
    if (m && env.CACHE && env.KV && (request.method === "GET" || request.method === "HEAD")) {
      var res = await serveFromCache(request, env, ctx, m[1], m[2]);
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
      ctx.waitUntil(ensureSessionLearned(env, request.clone(), syncMatch[1]));
    }

    var target = new URL(p + url.search, origin);
    var resp = await fetch(new Request(target.toString(), request), { redirect: "manual" });

    if (reqCloneForProgress && resp.ok) {
      ctx.waitUntil(checkProgressEviction(env, reqCloneForProgress, cp));
    }
    if (request.method === "POST" && env.KV && resp.ok && /^\/api\/items\/[^/]+\/play(\/[^/]+)?$/.test(cp)) {
      ctx.waitUntil(learnSession(env, resp.clone()));
    }
    if (request.method === "GET" && env.KV && resp.status === 200 && /^\/api\/items\/[^/]+$/.test(cp)) {
      ctx.waitUntil(learnItemDetails(env, resp.clone()));
    }
    if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS"
        && cp.indexOf("/api/") === 0 && resp.status < 400 && !NOBUMP.test(cp)) {
      ctx.waitUntil(bumpEpoch(env, url.origin + "/__edge/"));
    }
    if (cp.indexOf("/api/") === 0 && resp.status >= 200 && resp.status < 300) {
      ctx.waitUntil(markValid(request, url));
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
    ctx.waitUntil(record(env, request, out, url, cp));
    return out;
  },

  async queue(batch, env) {
    var r2State = await getR2State(env, true);
    if (!env.CACHE || r2State.tripped) {
      for (var m0 of batch.messages) m0.ack();
      return;
    }
    var lim = getLimits(env);
    var snapshot = [];
    var existingKeys = {};
    var currentTotal = 0;
    if (lim.guardEnabled) {
      snapshot = await listAllObjects(env);
      for (var o of snapshot) {
        existingKeys[o.key] = true;
        currentTotal += (o.size || 0);
      }
    }

    for (var msg of batch.messages) {
      var j = msg.body;
      try {
        var stateNow = await getR2State(env, false);
        if (stateNow.tripped) { msg.ack(); continue; }
        if (!j || !j.key || existingKeys[j.key]) { msg.ack(); continue; }
        if (!lim.guardEnabled && (await env.CACHE.head(j.key))) { msg.ack(); continue; }
        var activeItem = j.item || j.key.split("/")[0] || "";
        var origin = new URL(env.ORIGIN);
        var r = await fetch(new URL("/public/session/" + j.sid + "/track/" + j.n, origin).toString());
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
    if (lim.guardEnabled) await recordR2Ops(env, 0, 0, currentTotal, true);
  }
};
