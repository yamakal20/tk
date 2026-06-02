// functions/v/[[path]].js
// ★ catch-all route — /v/{id}.mp4 ရော /v/{id}/{filename} ရော ဖမ်းနိုင်
// tktube get_file → R2 direct link resolve လုပ်ပြီး proxy ပြန်ထုတ်
// ★ FIX: download manager (movie apk) file size စစ်နိုင်အောင် Content-Length မှန်အောင် ပြန်ပေး

const CACHE_TTL = 3000; // 50 မိနစ်

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0 Safari/537.36";

export async function onRequest(context) {
  const { request, params, env } = context;

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }

  // ───────────────────────────────────────────────
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

  const srcUrl = await env.LINKS.get(id);
  if (!srcUrl) {
    return new Response("ID ရှာမတွေ့ပါ", { status: 404 });
  }

  const customName = await env.LINKS.get("name:" + id);

  const reqUrl = new URL(request.url);
  const forceDownload = reqUrl.searchParams.get("dl") === "1";

  // ───────────────────────────────────────────────
  // ★ direct R2 link resolve (cache အရင်)
  const cacheKey = "direct:" + id;
  let direct = await env.LINKS.get(cacheKey);

  if (!direct) {
    try {
      direct = await resolveTktube(srcUrl);
    } catch (e) {
      return new Response("Resolve error: " + e.message, { status: 502 });
    }
    if (!direct) {
      return new Response("Direct link ရှာမတွေ့ပါ", { status: 502 });
    }
    await env.LINKS.put(cacheKey, direct, { expirationTtl: CACHE_TTL });
  }

  // ───────────────────────────────────────────────
  const filename =
    urlFilename || customName || extractFilename(srcUrl, direct);

  // ───────────────────────────────────────────────
  // ★ upstream fetch (Range forward)
  let upstream = await fetchUpstream(direct, request);

  // ★ link expire → ပြန် resolve
  if (
    upstream.status === 403 ||
    upstream.status === 410 ||
    upstream.status === 404
  ) {
    const fresh = await resolveTktube(srcUrl);
    if (fresh) {
      direct = fresh;
      await env.LINKS.put(cacheKey, direct, { expirationTtl: CACHE_TTL });
      upstream = await fetchUpstream(direct, request);
    }
  }

  // ───────────────────────────────────────────────
  // ★ response headers
  const respHeaders = new Headers();

  // ★ upstream content-length / content-range ကို forward
  const upLen = upstream.headers.get("content-length");
  const upRange = upstream.headers.get("content-range");

  for (const h of ["content-range", "last-modified", "etag"]) {
    const v = upstream.headers.get(h);
    if (v) respHeaders.set(h, v);
  }

  // ★★★ FIX 1: Content-Length မှန်အောင် ─────────────
  // download manager က file size ကို Content-Length ကနေ ဖတ်တယ်။
  // Range request (bytes=0-0) ဖြစ်ရင် partial length ပဲ ပြန်လာတာမို့
  // Content-Range ထဲက total size ကို ထုတ်ပြီး "full size" ကို တွက်ပေး။
  let totalSize = null;
  if (upRange) {
    // format: "bytes 0-0/123456789"
    const m = upRange.match(/\/(\d+)\s*$/);
    if (m) totalSize = m[1];
  }

  const reqHasRange = !!request.headers.get("Range");

  if (request.method === "HEAD") {
    // ★ HEAD မှာ download manager က total size လိုတယ် → totalSize ပေး
    if (totalSize) {
      respHeaders.set("Content-Length", totalSize);
      // HEAD မှာ partial range header မလို
      respHeaders.delete("content-range");
    } else if (upLen) {
      respHeaders.set("Content-Length", upLen);
    }
  } else {
    // GET
    if (reqHasRange) {
      // range request → upstream length အတိုင်း
      if (upLen) respHeaders.set("Content-Length", upLen);
    } else {
      // full GET → total size (သို့) upstream length
      if (totalSize) respHeaders.set("Content-Length", totalSize);
      else if (upLen) respHeaders.set("Content-Length", upLen);
    }
  }
  // ──────────────────────────────────────────────────

  respHeaders.set("Access-Control-Allow-Origin", "*");
  respHeaders.set("Accept-Ranges", "bytes");

  // ★★★ FIX 2: HEAD request မှာ status code ──────────
  // download manager က HEAD ကို 200 မျှော်တယ်။
  // upstream က Range မပါဘဲ HEAD ခေါ်ရင် 200 ပြန်လာသင့်။
  let respStatus = upstream.status;
  if (request.method === "HEAD") {
    // HEAD မှာ 206 ဖြစ်နေရင် 200 ပြန်ပြောင်း (size စစ်ရုံ)
    respStatus = upstream.status === 206 ? 200 : upstream.status;
  }
  // ──────────────────────────────────────────────────

  if (forceDownload) {
    respHeaders.set("Content-Type", "application/octet-stream");
    respHeaders.set(
      "Content-Disposition",
      `attachment; filename="${sanitizeAscii(filename)}"; ` +
        `filename*=UTF-8''${encodeURIComponent(filename)}`
    );
  } else {
    const upstreamType = upstream.headers.get("content-type");
    respHeaders.set(
      "Content-Type",
      upstreamType && upstreamType.startsWith("video/")
        ? upstreamType
        : "video/mp4"
    );
    respHeaders.set(
      "Content-Disposition",
      `inline; filename="${sanitizeAscii(filename)}"; ` +
        `filename*=UTF-8''${encodeURIComponent(filename)}`
    );
  }

  // ★ HEAD မှာ body မပါ
  const body = request.method === "HEAD" ? null : upstream.body;

  return new Response(body, {
    status: respStatus,
    headers: respHeaders,
  });
}

// ───────────────────────────────────────────────
// ★ upstream fetch helper (Range + UA forward)
//   ★ FIX 3: HEAD request လာရင် upstream ကို "bytes=0-0" Range GET နဲ့ ခေါ်
//            → R2 က Content-Range ထဲ total size ပြန်ပေးအောင်
async function fetchUpstream(direct, request) {
  const fwdHeaders = new Headers();
  fwdHeaders.set("User-Agent", UA);

  if (request.method === "HEAD") {
    // ★ HEAD: R2 က HEAD ကို Content-Length ပြန်မပေးတတ်တာမို့
    //   bytes=0-0 GET နဲ့ ခေါ်ပြီး Content-Range ထဲက total size ယူ
    fwdHeaders.set("Range", "bytes=0-0");
    return fetch(direct, {
      method: "GET",
      headers: fwdHeaders,
      redirect: "follow",
    });
  }

  const range = request.headers.get("Range");
  if (range) fwdHeaders.set("Range", range);

  return fetch(direct, {
    method: "GET",
    headers: fwdHeaders,
    redirect: "follow",
  });
}

// ───────────────────────────────────────────────
function sanitizeAscii(name) {
  return name.replace(/["\\\r\n]/g, "_").replace(/[^\x20-\x7E]/g, "_");
}

// ───────────────────────────────────────────────
function extractFilename(srcUrl, directUrl) {
  try {
    const parts = new URL(srcUrl).pathname.split("/").filter(Boolean);
    const last = decodeURIComponent(parts[parts.length - 1] || "");
    if (last.includes(".")) return last;
  } catch (_) {}

  try {
    const dParts = new URL(directUrl).pathname.split("/").filter(Boolean);
    const last = decodeURIComponent(dParts[dParts.length - 1] || "");
    if (last.includes(".")) return last;
  } catch (_) {}

  return "download.mp4";
}

// ───────────────────────────────────────────────
async function resolveTktube(srcUrl) {
  const headers = {
    "User-Agent": UA,
    Accept: "*/*",
    Referer: "https://tktube.com/",
  };

  let currentUrl = srcUrl;
  for (let i = 0; i < 5; i++) {
    let res = await fetch(currentUrl, {
      method: "HEAD",
      headers,
      redirect: "manual",
    });

    if (res.status === 405 || res.status === 501) {
      res = await fetch(currentUrl, {
        method: "GET",
        headers,
        redirect: "manual",
      });
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("Location");
      if (!loc) break;

      if (
        /r2\.cloudflarestorage\.com/i.test(loc) ||
        /X-Amz-Signature=/i.test(loc)
      ) {
        return loc;
      }

      currentUrl = new URL(loc, currentUrl).toString();
      continue;
    }

    if (
      /r2\.cloudflarestorage\.com/i.test(currentUrl) ||
      /X-Amz-Signature=/i.test(currentUrl)
    ) {
      return currentUrl;
    }
    break;
  }

  return null;
}
