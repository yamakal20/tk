// functions/v/[[path]].js
// /v/{id}.mp4 နှင့် /v/{id}/{filename} နှစ်မျိုးလုံး support
//
// ★★ ပြင်ဆင်ချက် (javtiful engine ထပ်ပြောင်း):
//   (1) R2 link (engine အဟောင်း)
//   (2) /media/video/{id}/{quality}?expires=..&signature=.. gateway link
//   (3) ★★★ အသစ် — fast-stream.jav.si/p/{hash-chain} direct video link
//       (R2/media မသုံးဘဲ page ကနေ တန်းထွက်လာတဲ့ link) — ထပ် resolve မလို၊ direct

const META_TTL = 3000;            // meta cache TTL = 50 မိနစ် (seconds)
const RESOLVE_LIMIT = 8;          // redirect chain max hop
const NOEXP_TTL = 2 * 60 * 60;    // exp မပါတဲ့ link cache = 2 နာရီ (7200s)
const CANDIDATE_BATCH = 6;        // candidate parallel resolve batch size
const CANDIDATE_CAP = 15;         // candidate max count

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// "direct video" host pattern
// ★ tktube / mmtube (get_file engine) + ★★★ fast-stream.jav.si ကိုပါ ထည့်
const DIRECT_HOST_RE =
  /(?:qyshare\.com|r2\.cloudflarestorage\.com|\.r2\.dev|cloudflarestream\.com|tktube\.com|mmtube\.net|fast-stream\.jav\.si|(?:^|\.)jav\.si)/i;

// token-ish direct endpoint (qyshare /api/share/download?token=...&fileId=...)
const DIRECT_PATH_RE =
  /\/(?:api\/share\/download|get_file|dl|download|stream)\b/i;

// ★★ javtiful gateway link — /media/video/{id}/{quality}?expires=..&signature=..
const MEDIA_GATEWAY_RE =
  /\/media\/video\/\d+\/[A-Za-z0-9]+/i;

// ★★★ အသစ် — fast-stream.jav.si/p/{hash-chunk-chain} direct video link
const FAST_STREAM_RE =
  /\/p\/[0-9a-f]{4,}(?:-[0-9a-f]{2,})+/i;

export async function onRequest(context) {
  const { request, params, env } = context;

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }

  let segments = params.path;
  if (typeof segments === "string") segments = [segments];

  if (!Array.isArray(segments) || segments.length === 0) {
    return new Response("Invalid path", { status: 400 });
  }

  let id = segments[0];
  if (id.includes(".")) id = id.substring(0, id.lastIndexOf("."));

  let urlFilename = "";
  if (segments.length >= 2) {
    urlFilename = decodeURIComponent(segments[segments.length - 1]);
  }

  const reqUrl = new URL(request.url);
  const forceInline = reqUrl.searchParams.get("dl") === "0";
  const forceDownload = !forceInline;

  const cache = caches.default;
  const metaCacheUrl = new URL(reqUrl.origin + "/__meta/" + id);

  let meta = null;

  // STEP 1: meta cache ဖတ်
  const cachedMeta = await cache.match(metaCacheUrl);
  if (cachedMeta) {
    try {
      meta = await cachedMeta.json();
    } catch (_) {
      meta = null;
    }
    if (meta && isHardExpired(meta)) meta = null;
  }

  // STEP 2: cache miss / hard-expired ဖြစ်မှသာ KV ဖတ်ပြီး resolve
  if (!meta) {
    const [srcUrl, customName] = await Promise.all([
      env.LINKS.get(id),
      env.LINKS.get("name:" + id),
    ]);

    if (!srcUrl) {
      return new Response("ID ရှာမတွေ့ပါ", { status: 404 });
    }

    let direct;
    try {
      direct = await resolveLink(srcUrl, env);
    } catch (e) {
      return new Response("Resolve error: " + e.message, { status: 502 });
    }

    if (!direct) {
      return new Response("Direct link ရှာမတွေ့ပါ", { status: 502 });
    }

    const filename =
      urlFilename || customName || extractFilename(srcUrl, direct);

    meta = {
      srcUrl,
      direct,
      filename,
      size: null,
      expireAt: getLinkExpiry(direct),
    };

    context.waitUntil(putMeta(cache, metaCacheUrl, meta, META_TTL));
  } else if (isNearExpiry(meta)) {
    context.waitUntil(
      (async () => {
        const fresh = await reResolve(env, meta);
        if (fresh) {
          const m2 = {
            ...meta,
            direct: fresh,
            expireAt: getLinkExpiry(fresh),
            size: null,
          };
          await putMeta(cache, metaCacheUrl, m2, META_TTL);
        }
      })()
    );
  }

  const filename = urlFilename || meta.filename || "download.mp4";

  // HEAD request
  if (request.method === "HEAD") {
    let totalSize = meta.size;

    if (!totalSize) {
      let headUp = await fetchHeadSize(meta.direct, meta.srcUrl);

      if (headUp.expired) {
        const fresh = await reResolve(env, meta);
        if (fresh) {
          meta.direct = fresh;
          meta.expireAt = getLinkExpiry(fresh);
          context.waitUntil(putMeta(cache, metaCacheUrl, meta, META_TTL));
          headUp = await fetchHeadSize(meta.direct, meta.srcUrl);
        }
      }

      totalSize = headUp.size;

      if (totalSize) {
        meta.size = totalSize;
        context.waitUntil(putMeta(cache, metaCacheUrl, meta, META_TTL));
      }
    }

    return buildHeadResponse(totalSize, filename, forceDownload);
  }

  // GET request — proxy stream
  let upstream = await fetchUpstream(meta.direct, request, meta.srcUrl);

  if (isUpstreamDead(upstream.status)) {
    if (upstream.body) {
      try {
        await upstream.body.cancel();
      } catch (_) {}
    }

    const fresh = await reResolve(env, meta);

    if (fresh) {
      meta.direct = fresh;
      meta.expireAt = getLinkExpiry(fresh);
      meta.size = null;

      context.waitUntil(putMeta(cache, metaCacheUrl, meta, META_TTL));

      upstream = await fetchUpstream(meta.direct, request, meta.srcUrl);
    }
  }

  if (isUpstreamDead(upstream.status)) {
    if (upstream.body) {
      try {
        await upstream.body.cancel();
      } catch (_) {}
    }
    return new Response("Upstream unavailable (" + upstream.status + ")", {
      status: 502,
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  }

  const respHeaders = new Headers();

  const upLen = upstream.headers.get("content-length");
  const upRange = upstream.headers.get("content-range");

  for (const h of ["content-range", "last-modified", "etag"]) {
    const v = upstream.headers.get(h);
    if (v) respHeaders.set(h, v);
  }

  let totalSize = null;
  if (upRange) {
    const m = upRange.match(/\/(\d+)\s*$/);
    if (m) totalSize = m[1];
  }

  if (totalSize && !meta.size) {
    meta.size = totalSize;
    context.waitUntil(putMeta(cache, metaCacheUrl, meta, META_TTL));
  }

  const reqHasRange = !!request.headers.get("Range");

  if (reqHasRange) {
    if (upLen) respHeaders.set("Content-Length", upLen);
  } else {
    if (totalSize) respHeaders.set("Content-Length", totalSize);
    else if (upLen) respHeaders.set("Content-Length", upLen);
  }

  respHeaders.set("Accept-Ranges", "bytes");
  respHeaders.set("Access-Control-Allow-Origin", "*");
  respHeaders.set("Cache-Control", "no-store");

  applyDisposition(respHeaders, filename, forceDownload, upstream);

  return new Response(upstream.body, {
    status: upstream.status,
    headers: respHeaders,
  });
}

// signed link expire time ဖတ်
function getLinkExpiry(direct) {
  try {
    const u = new URL(direct);
    const sp = u.searchParams;

    const amzDate = sp.get("X-Amz-Date");
    const amzExp = sp.get("X-Amz-Expires");

    if (amzDate && amzExp) {
      const m = amzDate.match(
        /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/
      );

      if (m) {
        const issued = Date.UTC(
          +m[1],
          +m[2] - 1,
          +m[3],
          +m[4],
          +m[5],
          +m[6]
        );

        return issued + parseInt(amzExp, 10) * 1000;
      }
    }

    for (const key of ["expires", "Expires", "e", "exp"]) {
      const v = sp.get(key);
      if (v && /^\d{9,13}$/.test(v)) {
        const n = parseInt(v, 10);
        return v.length <= 10 ? n * 1000 : n;
      }
    }
  } catch (_) {}

  return Date.now() + NOEXP_TTL * 1000;
}

function isHardExpired(meta) {
  if (!meta || !meta.expireAt) return false;
  return Date.now() >= meta.expireAt - 60_000;
}

function isNearExpiry(meta) {
  if (!meta || !meta.expireAt) return false;
  return Date.now() >= meta.expireAt - 5 * 60_000;
}

function isUpstreamDead(status) {
  return status === 403 || status === 404 || status === 410 || status === 401;
}

async function putMeta(cache, metaCacheUrl, meta, ttl) {
  try {
    let effectiveTtl = ttl;

    if (meta.expireAt) {
      const remain = Math.floor((meta.expireAt - Date.now()) / 1000);
      if (remain > 0 && remain < effectiveTtl) effectiveTtl = remain;
    }

    if (effectiveTtl < 1) effectiveTtl = 1;

    await cache.put(
      metaCacheUrl,
      new Response(JSON.stringify(meta), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "max-age=" + effectiveTtl,
        },
      })
    );
  } catch (_) {}
}

async function reResolve(env, meta) {
  try {
    const fresh = await resolveLink(meta.srcUrl, env);
    return fresh || null;
  } catch (_) {
    return null;
  }
}

// upstream fetch — Range forward + proxy stream
async function fetchUpstream(direct, request, srcUrl) {
  const fwdHeaders = new Headers();

  fwdHeaders.set("User-Agent", UA);
  fwdHeaders.set("Accept", "*/*");

  const referer = getRefererForSource(srcUrl, direct);
  if (referer) fwdHeaders.set("Referer", referer);

  const range = request.headers.get("Range");
  if (range) fwdHeaders.set("Range", range);

  return fetch(direct, {
    method: "GET",
    headers: fwdHeaders,
    redirect: "follow",
  });
}

async function fetchHeadSize(direct, srcUrl) {
  const fwdHeaders = new Headers();

  fwdHeaders.set("User-Agent", UA);
  fwdHeaders.set("Accept", "*/*");
  fwdHeaders.set("Range", "bytes=0-0");

  const referer = getRefererForSource(srcUrl, direct);
  if (referer) fwdHeaders.set("Referer", referer);

  const res = await fetch(direct, {
    method: "GET",
    headers: fwdHeaders,
    redirect: "follow",
  });

  if (res.body) {
    try {
      await res.body.cancel();
    } catch (_) {}
  }

  if (isUpstreamDead(res.status)) {
    return { expired: true, size: null };
  }

  let size = null;

  const cr = res.headers.get("content-range");
  if (cr) {
    const m = cr.match(/\/(\d+)\s*$/);
    if (m) size = m[1];
  }

  if (!size) {
    const cl = res.headers.get("content-length");
    if (cl && cl !== "1") size = cl;
  }

  return { expired: false, size };
}

function buildHeadResponse(totalSize, filename, forceDownload) {
  const h = new Headers();

  h.set("Access-Control-Allow-Origin", "*");
  h.set("Accept-Ranges", "bytes");

  if (totalSize) h.set("Content-Length", totalSize);

  applyDisposition(h, filename, forceDownload, null);

  return new Response(null, { status: 200, headers: h });
}

function applyDisposition(headers, filename, forceDownload, upstream) {
  if (forceDownload) {
    headers.set("Content-Type", "application/octet-stream");
    headers.set(
      "Content-Disposition",
      `attachment; filename="${sanitizeAscii(filename)}"; ` +
        `filename*=UTF-8''${encodeURIComponent(filename)}`
    );
  } else {
    let ctype = "video/mp4";

    if (upstream) {
      const ut = upstream.headers.get("content-type");
      if (ut && (ut.startsWith("video/") || ut.includes("mpegurl"))) {
        ctype = ut;
      }
    }

    headers.set("Content-Type", ctype);
    headers.set(
      "Content-Disposition",
      `inline; filename="${sanitizeAscii(filename)}"; ` +
        `filename*=UTF-8''${encodeURIComponent(filename)}`
    );
  }
}

function sanitizeAscii(name) {
  return String(name || "download.mp4")
    .replace(/["\\\r\n]/g, "_")
    .replace(/[^\x20-\x7E]/g, "_");
}

function safeFileName(name) {
  name = String(name || "").trim();
  name = name.replace(/[\/\\?%*:|"<>]/g, "_");
  name = name.replace(/\s+/g, "_");

  if (!name) name = "download.mp4";
  if (!name.includes(".")) name += ".mp4";

  return name;
}

function extractFilename(srcUrl, directUrl) {
  try {
    const src = new URL(srcUrl);
    const parts = src.pathname.split("/").filter(Boolean);
    let last = decodeURIComponent(parts[parts.length - 1] || "");

    if (
      last &&
      !/^(?:test|index|get_file|download|play|stream)\.\w+$/i.test(last) &&
      last.includes(".")
    ) {
      return safeFileName(last);
    }
  } catch (_) {}

  try {
    const dParts = new URL(directUrl).pathname.split("/").filter(Boolean);
    let last = decodeURIComponent(dParts[dParts.length - 1] || "");

    if (last && last.includes(".")) {
      return safeFileName(last);
    }
  } catch (_) {}

  return "download.mp4";
}

// Main resolver
async function resolveLink(srcUrl, env) {
  // ★★★ fast-stream.jav.si/p/{hash} direct link ဆို ထပ် resolve မလို — တန်းသုံး
  if (isFastStreamUrl(srcUrl)) {
    return srcUrl;
  }

  // ★★ gateway link ဆို ထပ် resolve → တကယ့် video
  if (isMediaGatewayUrl(srcUrl)) {
    const found = await resolveMediaGateway(srcUrl, env);
    if (found) return found;
    return srcUrl;
  }

  if (isDirectLink(srcUrl)) {
    return srcUrl;
  }

  if (isJavtifulPageUrl(srcUrl)) {
    const found = await resolveJavtiful(srcUrl, env);
    if (found) return found;
  }

  if (isTktubePageUrl(srcUrl)) {
    const found = await resolveTktube(srcUrl, env);
    if (found) return found;
  }

  return await resolveGeneric(srcUrl, env);
}

// ★★★ fast-stream.jav.si/p/{hash-chain} direct video URL စစ်
function isFastStreamUrl(u) {
  try {
    const url = new URL(u);
    const host = url.hostname.toLowerCase();

    const isJavSi = host === "jav.si" || host.endsWith(".jav.si");

    return isJavSi && FAST_STREAM_RE.test(url.pathname);
  } catch (_) {
    return false;
  }
}

// ★★ javtiful gateway URL စစ်
function isMediaGatewayUrl(u) {
  try {
    const url = new URL(u);
    const host = url.hostname.toLowerCase();

    const isJav =
      host === "javtiful.com" || host.endsWith(".javtiful.com");

    return isJav && MEDIA_GATEWAY_RE.test(url.pathname);
  } catch (_) {
    return false;
  }
}

// ★★ media gateway link ကို ဖွင့်ပြီး တကယ့် video link ဆွဲ
async function resolveMediaGateway(gatewayUrl, env) {
  const headers = buildPageHeaders(gatewayUrl, env);

  headers.set("Accept", "*/*");
  headers.set("Range", "bytes=0-0");

  let currentUrl = gatewayUrl;

  for (let i = 0; i < RESOLVE_LIMIT; i++) {
    let res;
    try {
      res = await fetch(currentUrl, {
        method: "GET",
        headers,
        redirect: "manual",
      });
    } catch (_) {
      return null;
    }

    // (a) redirect → Location ကို follow
    if (res.status >= 300 && res.status < 400) {
      if (res.body) {
        try {
          await res.body.cancel();
        } catch (_) {}
      }

      const loc = res.headers.get("Location");
      if (!loc) break;

      const absLoc = new URL(loc, currentUrl).toString();

      // ★★★ redirect Location က fast-stream link ဆို အဲဒါ direct
      if (isFastStreamUrl(absLoc)) return absLoc;
      if (isDirectLink(absLoc)) return absLoc;

      currentUrl = absLoc;
      continue;
    }

    const ct = (res.headers.get("content-type") || "").toLowerCase();

    // (b) video content တန်းပြန်လာ → ဒီ URL ကိုပဲ direct အဖြစ်သုံး
    if (
      ct.startsWith("video/") ||
      ct.includes("mpegurl") ||
      ct.startsWith("application/octet-stream")
    ) {
      if (res.body) {
        try {
          await res.body.cancel();
        } catch (_) {}
      }
      return currentUrl;
    }

    // (c) HTML / JSON ထဲက video link ရှာ
    if (
      ct.includes("text/html") ||
      ct.includes("json") ||
      ct.includes("javascript") ||
      ct.includes("text/plain")
    ) {
      let text = "";
      try {
        text = await res.text();
      } catch (_) {}

      const fast = extractFastStreamLink(text, currentUrl);
      if (fast) return fast;

      const gf = extractGetFileLink(text, currentUrl);
      if (gf) return gf;

      const found = extractDirectFromBody(text, currentUrl);
      if (found) return found;

      const cands = extractCandidateUrls(text, currentUrl);
      const fastHit = cands.find(isFastStreamUrl);
      if (fastHit) return fastHit;
      const dHit = cands.find(isDirectLink);
      if (dHit) return dHit;

      for (let j = 0; j < cands.length && j < CANDIDATE_BATCH; j++) {
        const r = await resolveCandidate(cands[j], currentUrl, env).catch(
          () => null
        );
        if (r) return r;
      }

      break;
    }

    if (res.body) {
      try {
        await res.body.cancel();
      } catch (_) {}
    }

    if (res.status >= 200 && res.status < 300) {
      return currentUrl;
    }

    break;
  }

  return null;
}

// ★ tktube.com / mmtube.net video page URL စစ်
function isTktubePageUrl(u) {
  try {
    const url = new URL(u);
    const host = url.hostname.toLowerCase();

    const isTk =
      host === "tktube.com" ||
      host.endsWith(".tktube.com") ||
      host === "mmtube.net" ||
      host.endsWith(".mmtube.net");

    return isTk && /^\/video\/\d+\//i.test(url.pathname);
  } catch (_) {
    return false;
  }
}

// ★ tktube / mmtube video page fetch → get_file link extract
async function resolveTktube(pageUrl, env) {
  const pageHeaders = buildPageHeaders(pageUrl, env);

  const res = await fetch(pageUrl, {
    method: "GET",
    headers: pageHeaders,
    redirect: "follow",
  });

  const ct = (res.headers.get("content-type") || "").toLowerCase();

  if (ct.startsWith("video/") || ct.startsWith("application/octet-stream")) {
    if (res.body) {
      try {
        await res.body.cancel();
      } catch (_) {}
    }
    return pageUrl;
  }

  let html = "";
  try {
    html = await res.text();
  } catch (_) {
    html = "";
  }

  const gf = extractGetFileLink(html, pageUrl);
  if (gf) return gf;

  let direct = extractDirectFromBody(html, pageUrl);
  if (direct) return direct;

  const candidates = extractCandidateUrls(html, pageUrl);

  const directHit = candidates.find(isDirectLink);
  if (directHit) return directHit;

  for (let i = 0; i < candidates.length; i += CANDIDATE_BATCH) {
    const batch = candidates.slice(i, i + CANDIDATE_BATCH);

    const results = await Promise.all(
      batch.map((c) => resolveCandidate(c, pageUrl, env).catch(() => null))
    );

    const hit = results.find((r) => r);
    if (hit) return hit;
  }

  return null;
}

// ★★★ fast-stream.jav.si/p/{hash-chain} link ကို HTML/JS ကနေ ဆွဲထုတ်
function extractFastStreamLink(text, baseUrl) {
  if (!text) return null;

  let source = String(text)
    .replace(/\\\//g, "/")
    .replace(/\\u0026/g, "&")
    .replace(/&amp;/g, "&")
    .replace(/&#038;/g, "&");

  const absRe =
    /https?:\/\/[A-Za-z0-9.\-]*jav\.si\/p\/[0-9a-f]{4,}(?:-[0-9a-f]{2,})+[^\s"'\\<>()]*/gi;
  const abs = source.match(absRe);
  if (abs && abs.length) {
    const best = abs.map(cleanUrl).sort((a, b) => b.length - a.length)[0];
    if (best) return best;
  }

  return null;
}

// ★ tktube / mmtube ရဲ့ get_file video link ကို HTML/JS ကနေ ဆွဲထုတ်
function extractGetFileLink(text, baseUrl) {
  if (!text) return null;

  let source = String(text)
    .replace(/\\\//g, "/")
    .replace(/\\u0026/g, "&")
    .replace(/&amp;/g, "&")
    .replace(/&#038;/g, "&");

  let origin = "";
  try {
    origin = new URL(baseUrl).origin;
  } catch (_) {}

  const absRe =
    /https?:\/\/[^\s"'\\<>()]+\/get_file\/[^\s"'\\<>()]+/gi;
  const abs = source.match(absRe);
  if (abs && abs.length) {
    const best = abs.map(cleanUrl).sort((a, b) => b.length - a.length)[0];
    if (best) return best;
  }

  if (origin) {
    const relRe = /["'](\/get_file\/[^\s"'\\<>()]+)["']/gi;
    let m;
    let best = "";
    while ((m = relRe.exec(source)) !== null) {
      const cand = cleanUrl(m[1]);
      if (cand.length > best.length) best = cand;
    }
    if (best) return origin + best;
  }

  return null;
}

// ★★ javtiful gateway link (/media/video/{id}/{quality}) ကို HTML/JS ကနေ ဆွဲထုတ်
function extractMediaGatewayLink(text, baseUrl) {
  if (!text) return null;

  let source = String(text)
    .replace(/\\\//g, "/")
    .replace(/\\u0026/g, "&")
    .replace(/&amp;/g, "&")
    .replace(/&#038;/g, "&");

  let origin = "";
  try {
    origin = new URL(baseUrl).origin;
  } catch (_) {}

  const absRe =
    /https?:\/\/[^\s"'\\<>()]+\/media\/video\/\d+\/[^\s"'\\<>()]+/gi;
  const abs = source.match(absRe);
  if (abs && abs.length) {
    const best = abs.map(cleanUrl).sort((a, b) => b.length - a.length)[0];
    if (best) return best;
  }

  if (origin) {
    const relRe = /["'](\/media\/video\/\d+\/[^\s"'\\<>()]+)["']/gi;
    let m;
    let best = "";
    while ((m = relRe.exec(source)) !== null) {
      const cand = cleanUrl(m[1]);
      if (cand.length > best.length) best = cand;
    }
    if (best) return origin + best;
  }

  return null;
}

// javtiful.com/video/... ကို fetch ပြီး video link extract
// ★★★ (0) ဦးစားပေးဆုံး — fast-stream.jav.si/p/{hash} ရှာ (engine အသစ်)
//    (A) မတွေ့ရင် — gateway link ရှာ → resolveMediaGateway
//    (B) မတွေ့ရင် — R2 / storage link (engine အဟောင်း)
async function resolveJavtiful(pageUrl, env) {
  const pageHeaders = buildPageHeaders(pageUrl, env);

  const res = await fetch(pageUrl, {
    method: "GET",
    headers: pageHeaders,
    redirect: "follow",
  });

  const ct = (res.headers.get("content-type") || "").toLowerCase();

  if (ct.startsWith("video/") || ct.startsWith("application/octet-stream")) {
    if (res.body) {
      try {
        await res.body.cancel();
      } catch (_) {}
    }
    return pageUrl;
  }

  let html = "";
  try {
    html = await res.text();
  } catch (_) {
    html = "";
  }

  // ★★★ (0) ဦးစားပေးဆုံး — fast-stream.jav.si/p/{hash} direct link
  const fast = extractFastStreamLink(html, pageUrl);
  if (fast) return fast;

  // ★★ (A) gateway link ရှာ → ထပ် resolve
  const gateway = extractMediaGatewayLink(html, pageUrl);
  if (gateway) {
    const real = await resolveMediaGateway(gateway, env);
    if (real) return real;
    return gateway;
  }

  // ★★ (B) legacy — R2 / storage link embed
  let direct = extractDirectFromBody(html, pageUrl);
  if (direct) return direct;

  const candidates = extractCandidateUrls(html, pageUrl);

  const fastHit = candidates.find(isFastStreamUrl);
  if (fastHit) return fastHit;

  const directHit = candidates.find(isDirectLink);
  if (directHit) return directHit;

  for (let i = 0; i < candidates.length; i += CANDIDATE_BATCH) {
    const batch = candidates.slice(i, i + CANDIDATE_BATCH);

    const results = await Promise.all(
      batch.map((c) => resolveCandidate(c, pageUrl, env).catch(() => null))
    );

    const hit = results.find((r) => r);
    if (hit) return hit;
  }

  return null;
}

async function resolveCandidate(candidateUrl, refererUrl, env) {
  const headers = buildPageHeaders(refererUrl, env);

  headers.set("X-Requested-With", "XMLHttpRequest");
  headers.set("Accept", "application/json,text/plain,text/html,*/*");

  let currentUrl = candidateUrl;

  for (let i = 0; i < RESOLVE_LIMIT; i++) {
    let res;

    try {
      res = await fetch(currentUrl, {
        method: "GET",
        headers,
        redirect: "manual",
      });
    } catch (_) {
      return null;
    }

    if (res.status >= 300 && res.status < 400) {
      if (res.body) {
        try {
          await res.body.cancel();
        } catch (_) {}
      }

      const loc = res.headers.get("Location");
      if (!loc) return null;

      const absLoc = new URL(loc, currentUrl).toString();
      if (isFastStreamUrl(absLoc)) return absLoc;
      if (isDirectLink(absLoc)) return absLoc;

      currentUrl = absLoc;
      continue;
    }

    const ct = (res.headers.get("content-type") || "").toLowerCase();

    if (
      ct.startsWith("video/") ||
      ct.includes("mpegurl") ||
      ct.startsWith("application/octet-stream")
    ) {
      if (res.body) {
        try {
          await res.body.cancel();
        } catch (_) {}
      }
      return currentUrl;
    }

    if (isDirectLink(currentUrl)) {
      if (res.body) {
        try {
          await res.body.cancel();
        } catch (_) {}
      }
      return currentUrl;
    }

    let text = "";
    try {
      text = await res.text();
    } catch (_) {
      text = "";
    }

    // ★★★ fast-stream link ကို candidate response ကနေလည်း ရှာ
    const fast = extractFastStreamLink(text, currentUrl);
    if (fast) return fast;

    // ★★ gateway link ကို candidate response ကနေလည်း ရှာ
    const gw = extractMediaGatewayLink(text, currentUrl);
    if (gw) {
      const real = await resolveMediaGateway(gw, env);
      if (real) return real;
      return gw;
    }

    const gf = extractGetFileLink(text, currentUrl);
    if (gf) return gf;

    const found = extractDirectFromBody(text, currentUrl);
    if (found) return found;

    const more = extractCandidateUrls(text, currentUrl);
    for (const m of more.slice(0, 5)) {
      if (isDirectLink(m)) return m;
    }

    break;
  }

  return null;
}

// Generic resolver
async function resolveGeneric(srcUrl, env) {
  const headers = buildPageHeaders(srcUrl, env);

  let currentUrl = srcUrl;

  for (let i = 0; i < RESOLVE_LIMIT; i++) {
    let res;
    try {
      res = await fetch(currentUrl, {
        method: "HEAD",
        headers,
        redirect: "manual",
      });
    } catch (_) {
      res = null;
    }

    const headUnsupported =
      !res || res.status === 405 || res.status === 501 || res.status === 400;

    if (!headUnsupported && res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("Location");
      if (loc) {
        const absLoc = new URL(loc, currentUrl).toString();
        if (isDirectLink(absLoc)) return absLoc;
        currentUrl = absLoc;
        continue;
      }
    }

    if (!headUnsupported) {
      if (res.status >= 200 && res.status < 300 && isDirectLink(currentUrl)) {
        return currentUrl;
      }

      const hct = (res.headers.get("content-type") || "").toLowerCase();
      if (
        res.status >= 200 &&
        res.status < 300 &&
        (hct.startsWith("video/") ||
          hct.includes("mpegurl") ||
          hct.startsWith("application/octet-stream"))
      ) {
        return currentUrl;
      }
    }

    const getRes = await fetch(currentUrl, {
      method: "GET",
      headers,
      redirect: "manual",
    });

    if (getRes.status >= 300 && getRes.status < 400) {
      if (getRes.body) {
        try {
          await getRes.body.cancel();
        } catch (_) {}
      }

      const loc = getRes.headers.get("Location");
      if (!loc) break;

      const absLoc = new URL(loc, currentUrl).toString();
      if (isDirectLink(absLoc)) return absLoc;

      currentUrl = absLoc;
      continue;
    }

    if (isDirectLink(currentUrl)) {
      if (getRes.body) {
        try {
          await getRes.body.cancel();
        } catch (_) {}
      }
      return currentUrl;
    }

    const ct = (getRes.headers.get("content-type") || "").toLowerCase();

    if (
      ct.startsWith("video/") ||
      ct.includes("mpegurl") ||
      ct.startsWith("application/octet-stream")
    ) {
      if (getRes.body) {
        try {
          await getRes.body.cancel();
        } catch (_) {}
      }
      return currentUrl;
    }

    if (
      ct.includes("text/html") ||
      ct.includes("javascript") ||
      ct.includes("json") ||
      ct.includes("text/plain")
    ) {
      let bodyText = "";
      try {
        bodyText = await getRes.text();
      } catch (_) {}

      // ★★★ fast-stream link ကို generic body ကနေလည်း ရှာ
      const fast = extractFastStreamLink(bodyText, currentUrl);
      if (fast) return fast;

      const gw = extractMediaGatewayLink(bodyText, currentUrl);
      if (gw) {
        const real = await resolveMediaGateway(gw, env);
        if (real) return real;
        return gw;
      }

      const gf = extractGetFileLink(bodyText, currentUrl);
      if (gf) return gf;

      const found = extractDirectFromBody(bodyText, currentUrl);
      if (found) return found;

      const cands = extractCandidateUrls(bodyText, currentUrl);

      const fastHit = cands.find(isFastStreamUrl);
      if (fastHit) return fastHit;

      const dHit = cands.find(isDirectLink);
      if (dHit) return dHit;

      for (let j = 0; j < cands.length && j < CANDIDATE_BATCH; j++) {
        const r = await resolveCandidate(cands[j], currentUrl, env).catch(
          () => null
        );
        if (r) return r;
      }
    } else if (getRes.body) {
      try {
        await getRes.body.cancel();
      } catch (_) {}
    }

    break;
  }

  return null;
}

function buildPageHeaders(url, env) {
  const headers = new Headers();

  headers.set("User-Agent", UA);
  headers.set(
    "Accept",
    "text/html,application/xhtml+xml,application/xml;q=0.9,application/json,text/plain,*/*;q=0.8"
  );
  headers.set("Accept-Language", "en-US,en;q=0.9");
  headers.set("Cache-Control", "no-cache");
  headers.set("Pragma", "no-cache");

  const referer = getRefererForSource(url);
  if (referer) headers.set("Referer", referer);

  if (
    env &&
    env.JAVTIFUL_COOKIE &&
    (isJavtifulPageUrl(url) || isMediaGatewayUrl(url) || isFastStreamUrl(url))
  ) {
    headers.set("Cookie", env.JAVTIFUL_COOKIE);
  }

  if (
    env &&
    env.SITE_COOKIE &&
    !isJavtifulPageUrl(url) &&
    !isMediaGatewayUrl(url) &&
    !isFastStreamUrl(url)
  ) {
    headers.set("Cookie", env.SITE_COOKIE);
  }

  return headers;
}

function getRefererForSource(srcUrl, directUrl = "") {
  // ★★★ fast-stream / jav.si direct link ဆို Referer ကို javtiful.com ထားပေး
  try {
    if (isFastStreamUrl(srcUrl) || isFastStreamUrl(directUrl)) {
      return "https://javtiful.com/";
    }
  } catch (_) {}

  try {
    const u = new URL(srcUrl || directUrl);
    return u.origin + "/";
  } catch (_) {}

  try {
    const d = new URL(directUrl);
    return d.origin + "/";
  } catch (_) {}

  return "https://google.com/";
}

function isJavtifulPageUrl(u) {
  try {
    const url = new URL(u);
    const host = url.hostname.toLowerCase();

    return (
      (host === "javtiful.com" || host.endsWith(".javtiful.com")) &&
      /^\/(?:[a-z]{2}\/)?video\/\d+\//i.test(url.pathname)
    );
  } catch (_) {
    return false;
  }
}

function isDirectLink(u) {
  if (!u) return false;

  // ★★★ fast-stream.jav.si/p/{hash} ဆို direct
  if (isFastStreamUrl(u)) return true;

  // ★★ gateway link ဆို direct မဟုတ် — ထပ် resolve
  if (isMediaGatewayUrl(u)) return false;

  if (DIRECT_HOST_RE.test(u)) return true;

  try {
    const url = new URL(u);

    if (/\/get_file\//i.test(url.pathname)) return true;

    if (
      DIRECT_PATH_RE.test(url.pathname) &&
      /[?&](?:token|fileid|file_id|fid|key|id|acctoken|v-acctoken)=/i.test(
        url.search
      )
    ) {
      return true;
    }

    if (/\.(?:mp4|m3u8|ts)\//i.test(url.pathname)) return true;
  } catch (_) {}

  return (
    /X-Amz-Signature=/i.test(u) ||
    /X-Amz-Credential=/i.test(u) ||
    /r2\.cloudflarestorage\.com/i.test(u) ||
    /(?:^|\.)r2\.dev\//i.test(u) ||
    /cloudflarestream\.com/i.test(u) ||
    /[?&](?:expires|e|exp|signature|sign|token|hash|md5|acctoken|v-acctoken)=/i.test(
      u
    ) ||
    /\.(?:mp4|m3u8|ts)(?:[?#/]|$)/i.test(u)
  );
}

function extractDirectFromBody(text, baseUrl, depth = 0) {
  if (!text) return null;

  let source = String(text);

  source = source
    .replace(/\\\//g, "/")
    .replace(/\\u0026/g, "&")
    .replace(/&amp;/g, "&")
    .replace(/&#038;/g, "&");

  const storageRe =
    /https?:\/\/[^\s"'\\<>()]+(?:(?:r2\.cloudflarestorage\.com)|(?:\.r2\.dev)|(?:cloudflarestream\.com)|(?:qyshare\.com)|(?:\/get_file\/)|(?:\.mp4)|(?:\.m3u8))[^\s"'\\<>()]*/gi;

  const storage = source.match(storageRe);
  if (storage && storage.length) {
    const sorted = storage
      .map(cleanUrl)
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    const good = sorted.find(isDirectLink);
    if (good) return good;
  }

  const signedRe =
    /https?:\/\/[^\s"'\\<>()]+(?:X-Amz-Signature=|X-Amz-Credential=|[?&](?:expires|signature|sign|token|hash|md5|acctoken|v-acctoken)=)[^\s"'\\<>()]*/gi;

  const signed = source.match(signedRe);
  if (signed && signed.length) {
    const cleaned = signed
      .map(cleanUrl)
      .filter((x) => x && !isMediaGatewayUrl(x))
      .sort((a, b) => b.length - a.length);
    if (cleaned.length) return cleaned[0];
  }

  const fileRe =
    /(?:file|src|url|source|videoUrl|video_url|stream|stream_url|hls|hlsUrl|playlist)\s*[:=]\s*["']([^"']+(?:\.(?:mp4|m3u8)|\/get_file\/)[^"']*)["']/gi;

  let m;
  while ((m = fileRe.exec(source)) !== null) {
    try {
      const abs = new URL(m[1], baseUrl).toString();
      if (isDirectLink(abs)) return cleanUrl(abs);
    } catch (_) {}
  }

  const quotedUrlRe =
    /["'](https?:\/\/[^"']+(?:\.(?:mp4|m3u8)(?:\?[^"']*)?|\/get_file\/[^"']*))["']/gi;

  while ((m = quotedUrlRe.exec(source)) !== null) {
    const u = cleanUrl(m[1]);
    if (isDirectLink(u)) return u;
  }

  if (depth < 1) {
    const b64Re = /["']([A-Za-z0-9+/=]{80,})["']/g;
    let b;

    while ((b = b64Re.exec(source)) !== null) {
      try {
        const decoded = atob(b[1]);
        if (/https?:\/\//i.test(decoded)) {
          const found = extractDirectFromBody(decoded, baseUrl, depth + 1);
          if (found) return found;
        }
      } catch (_) {}
    }
  }

  return null;
}

function extractCandidateUrls(text, baseUrl) {
  const out = [];
  const seen = new Set();

  if (!text) return out;

  let source = String(text);

  source = source
    .replace(/\\\//g, "/")
    .replace(/\\u0026/g, "&")
    .replace(/&amp;/g, "&")
    .replace(/&#038;/g, "&");

  function add(u) {
    try {
      if (!u) return;

      if (/^(javascript:|data:|mailto:|tel:)/i.test(u)) return;

      const abs = new URL(u, baseUrl).toString();

      if (seen.has(abs)) return;
      seen.add(abs);

      // ★★★ fast-stream link ဆို ဦးစားပေး ထည့်
      if (isFastStreamUrl(abs)) {
        out.push(abs);
        return;
      }

      if (isDirectLink(abs)) {
        out.push(abs);
        return;
      }

      const parsed = new URL(abs);
      const p = parsed.pathname.toLowerCase();
      const q = parsed.search.toLowerCase();

      if (isMediaGatewayUrl(abs)) {
        out.push(abs);
        return;
      }

      if (
        /\/(?:api|ajax|source|sources|stream|streams|player|playlist|download|embed|hls|m3u8|get_file|media)\b/i.test(
          p
        ) ||
        /(?:source|stream|video|file|token|download|hls)/i.test(q)
      ) {
        out.push(abs);
      }
    } catch (_) {}
  }

  const quotedRe = /["']([^"']{1,2000})["']/g;
  let m;

  while ((m = quotedRe.exec(source)) !== null) {
    const val = m[1].trim();

    if (/^https?:\/\//i.test(val) || /^\/[A-Za-z0-9_\-./?=&%]+/i.test(val)) {
      add(val);
    }
  }

  const attrRe =
    /(?:href|src|data-src|data-url|data-video|data-file|data-stream|data-source|data-player)\s*=\s*["']([^"']+)["']/gi;

  while ((m = attrRe.exec(source)) !== null) {
    add(m[1]);
  }

  out.sort((a, b) => {
    const da = isFastStreamUrl(a) ? 0 : isDirectLink(a) ? 1 : 2;
    const db = isFastStreamUrl(b) ? 0 : isDirectLink(b) ? 1 : 2;
    return da - db;
  });

  return out.slice(0, CANDIDATE_CAP);
}

function cleanUrl(u) {
  return String(u || "")
    .replace(/[)"';\\]+$/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&#038;/g, "&")
    .trim();
}
