// functions/v/[[path]].js
// ★ catch-all route — /v/{id}.mp4 ရော /v/{id}/{filename} ရော နှစ်မျိုးလုံး ဖမ်းနိုင်
// tktube get_file → R2 အချိန်ပိုင်း direct link ကို resolve လုပ်ပြီး proxy ပြန်ထုတ်
// ★ R2 link က အချိန်ပိုင်းခံ (X-Amz-Expires=3600 ≈ 1 နာရီ) ဖြစ်လို့ cache ကို တို(60s)ပဲ ထား
// ★ browser မှာ play မဖြစ်ဘဲ ဖိုင်တန်းဒေါင်းအောင် attachment သုံးထားသည်
// ★ custom filename support (URL path ထဲကရော KV ကရော)

const CACHE_TTL = 60; // ★ R2 link အချိန်ပိုင်းခံမို့ cache ၁ မိနစ်ပဲ (စက္ကန့်)

export async function onRequest(context) {
  const { request, params, env } = context;

  // GET / HEAD သာ ခွင့်ပြု
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }

  // ───────────────────────────────────────────────
  // ★ path ကို ပိုင်းခြား
  // params.path က array ဖြစ်နိုင် (catch-all) ဒါမှမဟုတ် string
  // ဖြစ်နိုင်တဲ့ပုံစံ:
  //   ["a9539b49.mp4"]              → /v/a9539b49.mp4
  //   ["a9539b49", "myvideo.mp4"]   → /v/a9539b49/myvideo.mp4
  let segments = params.path;
  if (typeof segments === "string") segments = [segments];
  if (!Array.isArray(segments) || segments.length === 0) {
    return new Response("Invalid path", { status: 400 });
  }

  // ★ ID = ပထမ segment (extension ဖယ်)
  let id = segments[0];
  if (id.includes(".")) id = id.substring(0, id.lastIndexOf("."));

  // ★ URL path ထဲက filename (ဒုတိယ segment ရှိရင် အဲ့ဒါ filename)
  let urlFilename = "";
  if (segments.length >= 2) {
    urlFilename = decodeURIComponent(segments[segments.length - 1]);
  }

  // source (tktube get_file) link ရှာ
  const srcUrl = await env.LINKS.get(id);
  if (!srcUrl) {
    return new Response("ID ရှာမတွေ့ပါ", { status: 404 });
  }

  // ★ user ပေးထားတဲ့ custom filename ရှာ (KV)
  const customName = await env.LINKS.get("name:" + id);

  // ★ cache အရင်စစ် — resolve လုပ်ထားတဲ့ direct R2 link ရှိပြီးသားလား
  const cacheKey = "direct:" + id;
  let direct = await env.LINKS.get(cacheKey);

  if (!direct) {
    // cache မှာ မရှိ → tktube ကို အသစ်ပြန် resolve
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
  // ★ ဖိုင်နာမည် ဆုံးဖြတ်ခြင်း (priority order):
  //   1) URL path ထဲက filename (download manager က ဒါကို ယူတယ်)
  //   2) KV ထဲက custom name
  //   3) source URL ကနေ ထုတ်ယူ
  const filename =
    urlFilename || customName || extractFilename(srcUrl, direct);

  // Range request forward (seek/resume support)
  const fwdHeaders = new Headers();
  const range = request.headers.get("Range");
  if (range) fwdHeaders.set("Range", range);
  fwdHeaders.set(
    "User-Agent",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
  );

  let upstream = await fetch(direct, {
    method: request.method === "HEAD" ? "HEAD" : "GET",
    headers: fwdHeaders,
    redirect: "follow",
  });

  // ★ cache ထဲက R2 link expire ဖြစ်နေရင် (403/410/404) → ပြန် resolve ပြီး ထပ်ကြိုး
  if (upstream.status === 403 || upstream.status === 410 || upstream.status === 404) {
    const fresh = await resolveTktube(srcUrl);
    if (fresh) {
      direct = fresh;
      await env.LINKS.put(cacheKey, direct, { expirationTtl: CACHE_TTL });
      upstream = await fetch(direct, {
        method: request.method === "HEAD" ? "HEAD" : "GET",
        headers: fwdHeaders,
        redirect: "follow",
      });
    }
  }

  const respHeaders = new Headers();
  for (const h of [
    "content-length", "content-range",
    "accept-ranges", "last-modified", "etag",
  ]) {
    const v = upstream.headers.get(h);
    if (v) respHeaders.set(h, v);
  }
  respHeaders.set("Access-Control-Allow-Origin", "*");
  respHeaders.set("Accept-Ranges", "bytes");

  // ★★★ play မဖြစ်ဘဲ ဖိုင်တန်းဒေါင်းအောင် ★★★
  respHeaders.set("Content-Type", "application/octet-stream");
  respHeaders.set(
    "Content-Disposition",
    `attachment; filename="${sanitizeAscii(filename)}"; ` +
      `filename*=UTF-8''${encodeURIComponent(filename)}`
  );

  return new Response(upstream.body, {
    status: upstream.status,
    headers: respHeaders,
  });
}

// ───────────────────────────────────────────────
// filename ထဲက အန္တရာယ်ရှိနိုင်တဲ့ character (quote, newline) တွေ ဖယ်
function sanitizeAscii(name) {
  return name.replace(/["\\\r\n]/g, "_").replace(/[^\x20-\x7E]/g, "_");
}

// ───────────────────────────────────────────────
// source URL (tktube get_file) သို့မဟုတ် direct R2 URL ကနေ ဖိုင်နာမည် ဆွဲထုတ်
function extractFilename(srcUrl, directUrl) {
  // ★ tktube get_file URL ပုံစံ: .../get_file/53/HASH/273000/273671/273671_720p.mp4
  //   → နောက်ဆုံး segment က ဖိုင်နာမည် (273671_720p.mp4)
  try {
    const parts = new URL(srcUrl).pathname.split("/").filter(Boolean);
    const last = decodeURIComponent(parts[parts.length - 1] || "");
    if (last.includes(".")) return last;
  } catch (_) {}

  // ★ direct R2 URL ရဲ့ နောက်ဆုံး segment ကနေ ကြိုးစား
  //   (query string က URL parse လုပ်ရင် pathname ထဲ မပါတော့ ဘေးကင်း)
  try {
    const dParts = new URL(directUrl).pathname.split("/").filter(Boolean);
    const last = decodeURIComponent(dParts[dParts.length - 1] || "");
    if (last.includes(".")) return last;
  } catch (_) {}

  return "download.mp4";
}

// ───────────────────────────────────────────────
// ★ tktube get_file link ကို resolve → R2 အချိန်ပိုင်း direct link ထုတ်
//   get_file link က 302 redirect နဲ့ R2 link ဆီ ပို့ပေးတာမို့
//   redirect: "manual" သုံးပြီး Location header ထဲက link ကို ဆွဲထုတ်
async function resolveTktube(srcUrl) {
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    "Accept": "*/*",
    "Referer": "https://tktube.com/",
  };

  // ★ redirect chain ကို ကိုယ်တိုင်လိုက် (R2 link မရောက်မချင်း သို့ အကြိမ်ကန့်)
  let currentUrl = srcUrl;
  for (let i = 0; i < 5; i++) {
    const res = await fetch(currentUrl, {
      method: "GET",
      headers,
      redirect: "manual",
    });

    // 3xx redirect → Location header ယူ
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("Location");
      if (!loc) break;

      // ★ R2 (cloudflarestorage) link ဆီ ရောက်ပြီဆိုရင် အဲ့ဒါပဲ ပြန်
      if (/r2\.cloudflarestorage\.com/i.test(loc) || /X-Amz-Signature=/i.test(loc)) {
        return loc;
      }

      // relative redirect ဆို absolute ပြောင်း
      currentUrl = new URL(loc, currentUrl).toString();
      continue;
    }

    // redirect မဟုတ်တော့ဘူး — ဒီ URL ကိုယ်တိုင်က R2 link ဖြစ်နေနိုင်
    if (/r2\.cloudflarestorage\.com/i.test(currentUrl) || /X-Amz-Signature=/i.test(currentUrl)) {
      return currentUrl;
    }
    break;
  }

  return null;
}
