// functions/v/[[path]].js
// ★ catch-all route — /v/{id}.mp4 ရော /v/{id}/{filename} ရော ဖမ်းနိုင်
// tktube get_file → R2 direct link resolve လုပ်ပြီး proxy ပြန်ထုတ်
//
// ★ optimization များ:
//   1) cache TTL ကို R2 expire (3600s) နဲ့ နီးစပ်အောင် 3000s (50min) တင်
//   2) resolveTktube မှာ HEAD သုံး (body မဆွဲ → ပိုမြန်)
//   3) cache miss အခါ ပထမ resolve ပြီးတာနဲ့ ချက်ချင်း KV write
//   4) ?dl=1 ဆိုရင်သာ download၊ default က stream (play) ဖြစ်
//   5) expired link auto re-resolve

// ★ R2 presigned link 1 နာရီ ခံတယ်။ buffer 10min ထားပြီး 50min cache
const CACHE_TTL = 3000; // 50 မိနစ် (စက္ကန့်)

// ★ resolve လုပ်တဲ့အခါ player/UA header
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0 Safari/537.36";

export async function onRequest(context) {
  const { request, params, env } = context;

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }

  // ───────────────────────────────────────────────
  // ★ path ပိုင်းခြား
  let segments = params.path;
  if (typeof segments === "string") segments = [segments];
  if (!Array.isArray(segments) || segments.length === 0) {
    return new Response("Invalid path", { status: 400 });
  }

  // ★ ID = ပထမ segment (extension ဖယ်)
  let id = segments[0];
  if (id.includes(".")) id = id.substring(0, id.lastIndexOf("."));

  // ★ URL path ထဲက filename
  let urlFilename = "";
  if (segments.length >= 2) {
    urlFilename = decodeURIComponent(segments[segments.length - 1]);
  }

  // source link ရှာ
  const srcUrl = await env.LINKS.get(id);
  if (!srcUrl) {
    return new Response("ID ရှာမတွေ့ပါ", { status: 404 });
  }

  // ★ custom filename (KV)
  const customName = await env.LINKS.get("name:" + id);

  // ★ download mode ဟုတ်မဟုတ် (?dl=1)
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
    // ★ ချက်ချင်း cache write — နောက်လာမယ့် range request တွေ resolve မလုပ်တော့
    await env.LINKS.put(cacheKey, direct, { expirationTtl: CACHE_TTL });
  }

  // ───────────────────────────────────────────────
  // ★ ဖိုင်နာမည်
  const filename =
    urlFilename || customName || extractFilename(srcUrl, direct);

  // ───────────────────────────────────────────────
  // ★ upstream fetch (Range forward)
  let upstream = await fetchUpstream(direct, request);

  // ★ link expire (403/410/404) → ပြန် resolve ပြီး ထပ်ကြိုး
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
  for (const h of [
    "content-length",
    "content-range",
    "accept-ranges",
    "last-modified",
    "etag",
  ]) {
    const v = upstream.headers.get(h);
    if (v) respHeaders.set(h, v);
  }
  respHeaders.set("Access-Control-Allow-Origin", "*");
  respHeaders.set("Accept-Ranges", "bytes");

  if (forceDownload) {
    // ★★★ ?dl=1 → ဖိုင်တန်းဒေါင်း ★★★
    respHeaders.set("Content-Type", "application/octet-stream");
    respHeaders.set(
      "Content-Disposition",
      `attachment; filename="${sanitizeAscii(filename)}"; ` +
        `filename*=UTF-8''${encodeURIComponent(filename)}`
    );
  } else {
    // ★★★ default → browser/player မှာ play (stream) ဖြစ်အောင် ★★★
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

  return new Response(upstream.body, {
    status: upstream.status,
    headers: respHeaders,
  });
}

// ───────────────────────────────────────────────
// ★ upstream fetch helper (Range + UA forward)
async function fetchUpstream(direct, request) {
  const fwdHeaders = new Headers();
  const range = request.headers.get("Range");
  if (range) fwdHeaders.set("Range", range);
  fwdHeaders.set("User-Agent", UA);

  return fetch(direct, {
    method: request.method === "HEAD" ? "HEAD" : "GET",
    headers: fwdHeaders,
    redirect: "follow",
  });
}

// ───────────────────────────────────────────────
// filename sanitize
function sanitizeAscii(name) {
  return name.replace(/["\\\r\n]/g, "_").replace(/[^\x20-\x7E]/g, "_");
}

// ───────────────────────────────────────────────
// filename extract
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
// ★ tktube get_file → R2 direct link resolve
//   ★ HEAD သုံး → body မဆွဲ → ပိုမြန် (redirect Location ပဲ လို)
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

    // ★ server တချို့ HEAD ကို 405/501 ပြန်တတ် → GET fallback
    if (res.status === 405 || res.status === 501) {
      res = await fetch(currentUrl, {
        method: "GET",
        headers,
        redirect: "manual",
      });
    }

    // 3xx → Location
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

    // redirect မဟုတ်တော့ — ဒီ URL ကိုယ်တိုင် R2 link ဖြစ်နိုင်
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
