// functions/v/[[path]].js
// /v/{id}.mp4 နှင့် /v/{id}/{filename} နှစ်မျိုးလုံး support
//
// Javtiful engine support:
//   (1) Legacy R2 / storage link
//   (2) /media/video/{id}/{quality}?expires=... gateway
//   (3) fast-stream.jav.si/p/{hash-chain}
//   (4) Main page မှာ source မတွေ့ရင် /embed/{videoId} fallback
//
// ကျန် behavior:
//   - Code 2 ရဲ့ proxy/download behavior မပြောင်း
//   - Range request support
//   - HEAD size detection
//   - tktube / mmtube support မပြောင်း

const META_TTL = 3000;
const RESOLVE_LIMIT = 8;
const NOEXP_TTL = 2 * 60 * 60;
const CANDIDATE_BATCH = 6;
const CANDIDATE_CAP = 15;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const DIRECT_HOST_RE =
  /(?:qyshare\.com|r2\.cloudflarestorage\.com|\.r2\.dev|cloudflarestream\.com|tktube\.com|mmtube\.net|fast-stream\.jav\.si|(?:^|\.)jav\.si)/i;

const DIRECT_PATH_RE =
  /\/(?:api\/share\/download|get_file|dl|download|stream)\b/i;

const MEDIA_GATEWAY_RE =
  /\/media\/video\/\d+\/[A-Za-z0-9]+/i;

const FAST_STREAM_RE =
  /\/p\/[0-9a-f]{4,}(?:-[0-9a-f]{2,})+/i;

export async function onRequest(context) {
  const { request, params, env } = context;

  if (
    request.method !== "GET" &&
    request.method !== "HEAD"
  ) {
    return new Response("Method not allowed", {
      status: 405,
    });
  }

  let segments = params.path;

  if (typeof segments === "string") {
    segments = [segments];
  }

  if (
    !Array.isArray(segments) ||
    segments.length === 0
  ) {
    return new Response("Invalid path", {
      status: 400,
    });
  }

  let id = String(segments[0] || "").trim();

  if (id.includes(".")) {
    id = id.substring(
      0,
      id.lastIndexOf(".")
    );
  }

  if (!id) {
    return new Response("Invalid ID", {
      status: 400,
    });
  }

  let urlFilename = "";

  if (segments.length >= 2) {
    try {
      urlFilename = decodeURIComponent(
        segments[segments.length - 1]
      );
    } catch (_) {
      urlFilename =
        segments[segments.length - 1];
    }
  }

  const reqUrl = new URL(request.url);

  const forceInline =
    reqUrl.searchParams.get("dl") === "0";

  const forceDownload = !forceInline;

  const cache = caches.default;

  const metaCacheUrl = new URL(
    reqUrl.origin +
      "/__meta/" +
      encodeURIComponent(id)
  );

  let meta = null;

  // STEP 1: meta cache ဖတ်
  const cachedMeta =
    await cache.match(metaCacheUrl);

  if (cachedMeta) {
    try {
      meta = await cachedMeta.json();
    } catch (_) {
      meta = null;
    }

    if (meta && isHardExpired(meta)) {
      meta = null;
    }
  }

  // STEP 2: cache miss / hard-expired ဖြစ်မှ KV ဖတ်ပြီး resolve
  if (!meta) {
    const [srcUrl, customName] =
      await Promise.all([
        env.LINKS.get(id),
        env.LINKS.get("name:" + id),
      ]);

    if (!srcUrl) {
      return new Response(
        "ID ရှာမတွေ့ပါ",
        {
          status: 404,
        }
      );
    }

    let direct;

    try {
      direct = await resolveLink(
        srcUrl,
        env
      );
    } catch (error) {
      return new Response(
        "Resolve error: " +
          getErrorMessage(error),
        {
          status: 502,
        }
      );
    }

    if (!direct) {
      return new Response(
        "Direct link ရှာမတွေ့ပါ",
        {
          status: 502,
        }
      );
    }

    const filename =
      urlFilename ||
      customName ||
      extractFilename(srcUrl, direct);

    meta = {
      srcUrl,
      direct,
      filename,
      size: null,
      expireAt: getLinkExpiry(direct),
    };

    context.waitUntil(
      putMeta(
        cache,
        metaCacheUrl,
        meta,
        META_TTL
      )
    );
  } else if (isNearExpiry(meta)) {
    context.waitUntil(
      (async () => {
        const fresh =
          await reResolve(env, meta);

        if (!fresh) return;

        const freshMeta = {
          ...meta,
          direct: fresh,
          expireAt: getLinkExpiry(fresh),
          size: null,
        };

        await putMeta(
          cache,
          metaCacheUrl,
          freshMeta,
          META_TTL
        );
      })()
    );
  }

  const filename =
    urlFilename ||
    meta.filename ||
    "download.mp4";

  // HEAD request
  if (request.method === "HEAD") {
    let totalSize = meta.size;

    if (!totalSize) {
      let headUp = await fetchHeadSize(
        meta.direct,
        meta.srcUrl
      );

      if (headUp.expired) {
        const fresh =
          await reResolve(env, meta);

        if (fresh) {
          meta.direct = fresh;
          meta.expireAt =
            getLinkExpiry(fresh);
          meta.size = null;

          context.waitUntil(
            putMeta(
              cache,
              metaCacheUrl,
              meta,
              META_TTL
            )
          );

          headUp = await fetchHeadSize(
            meta.direct,
            meta.srcUrl
          );
        }
      }

      totalSize = headUp.size;

      if (totalSize) {
        meta.size = totalSize;

        context.waitUntil(
          putMeta(
            cache,
            metaCacheUrl,
            meta,
            META_TTL
          )
        );
      }
    }

    return buildHeadResponse(
      totalSize,
      filename,
      forceDownload
    );
  }

  // GET request — proxy stream
  let upstream = await fetchUpstream(
    meta.direct,
    request,
    meta.srcUrl
  );

  if (isUpstreamDead(upstream.status)) {
    if (upstream.body) {
      try {
        await upstream.body.cancel();
      } catch (_) {}
    }

    const fresh =
      await reResolve(env, meta);

    if (fresh) {
      meta.direct = fresh;
      meta.expireAt =
        getLinkExpiry(fresh);
      meta.size = null;

      context.waitUntil(
        putMeta(
          cache,
          metaCacheUrl,
          meta,
          META_TTL
        )
      );

      upstream = await fetchUpstream(
        meta.direct,
        request,
        meta.srcUrl
      );
    }
  }

  if (isUpstreamDead(upstream.status)) {
    if (upstream.body) {
      try {
        await upstream.body.cancel();
      } catch (_) {}
    }

    return new Response(
      "Upstream unavailable (" +
        upstream.status +
        ")",
      {
        status: 502,
        headers: {
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }

  const respHeaders = new Headers();

  const upLen =
    upstream.headers.get(
      "content-length"
    );

  const upRange =
    upstream.headers.get(
      "content-range"
    );

  for (const headerName of [
    "content-range",
    "last-modified",
    "etag",
  ]) {
    const value =
      upstream.headers.get(headerName);

    if (value) {
      respHeaders.set(
        headerName,
        value
      );
    }
  }

  let totalSize = null;

  if (upRange) {
    const match =
      upRange.match(/\/(\d+)\s*$/);

    if (match) {
      totalSize = match[1];
    }
  }

  if (totalSize && !meta.size) {
    meta.size = totalSize;

    context.waitUntil(
      putMeta(
        cache,
        metaCacheUrl,
        meta,
        META_TTL
      )
    );
  }

  const reqHasRange =
    !!request.headers.get("Range");

  if (reqHasRange) {
    if (upLen) {
      respHeaders.set(
        "Content-Length",
        upLen
      );
    }
  } else {
    if (totalSize) {
      respHeaders.set(
        "Content-Length",
        totalSize
      );
    } else if (upLen) {
      respHeaders.set(
        "Content-Length",
        upLen
      );
    }
  }

  respHeaders.set(
    "Accept-Ranges",
    "bytes"
  );

  respHeaders.set(
    "Access-Control-Allow-Origin",
    "*"
  );

  respHeaders.set(
    "Cache-Control",
    "no-store"
  );

  applyDisposition(
    respHeaders,
    filename,
    forceDownload,
    upstream
  );

  return new Response(upstream.body, {
    status: upstream.status,
    headers: respHeaders,
  });
}

// signed link expire time ဖတ်
function getLinkExpiry(direct) {
  try {
    const url = new URL(direct);
    const searchParams =
      url.searchParams;

    const amzDate =
      searchParams.get("X-Amz-Date");

    const amzExpires =
      searchParams.get(
        "X-Amz-Expires"
      );

    if (amzDate && amzExpires) {
      const match = amzDate.match(
        /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/
      );

      if (match) {
        const issued = Date.UTC(
          Number(match[1]),
          Number(match[2]) - 1,
          Number(match[3]),
          Number(match[4]),
          Number(match[5]),
          Number(match[6])
        );

        return (
          issued +
          parseInt(amzExpires, 10) *
            1000
        );
      }
    }

    for (const key of [
      "expires",
      "Expires",
      "e",
      "exp",
    ]) {
      const value =
        searchParams.get(key);

      if (
        value &&
        /^\d{9,13}$/.test(value)
      ) {
        const expiry =
          parseInt(value, 10);

        return value.length <= 10
          ? expiry * 1000
          : expiry;
      }
    }
  } catch (_) {}

  return (
    Date.now() +
    NOEXP_TTL * 1000
  );
}

function isHardExpired(meta) {
  if (!meta || !meta.expireAt) {
    return false;
  }

  return (
    Date.now() >=
    meta.expireAt - 60_000
  );
}

function isNearExpiry(meta) {
  if (!meta || !meta.expireAt) {
    return false;
  }

  return (
    Date.now() >=
    meta.expireAt - 5 * 60_000
  );
}

function isUpstreamDead(status) {
  return (
    status === 403 ||
    status === 404 ||
    status === 410 ||
    status === 401
  );
}

async function putMeta(
  cache,
  metaCacheUrl,
  meta,
  ttl
) {
  try {
    let effectiveTtl = ttl;

    if (meta.expireAt) {
      const remaining = Math.floor(
        (meta.expireAt - Date.now()) /
          1000
      );

      if (
        remaining > 0 &&
        remaining < effectiveTtl
      ) {
        effectiveTtl = remaining;
      }
    }

    if (effectiveTtl < 1) {
      effectiveTtl = 1;
    }

    await cache.put(
      metaCacheUrl,
      new Response(
        JSON.stringify(meta),
        {
          headers: {
            "Content-Type":
              "application/json",
            "Cache-Control":
              "max-age=" +
              effectiveTtl,
          },
        }
      )
    );
  } catch (_) {}
}

async function reResolve(env, meta) {
  try {
    const fresh = await resolveLink(
      meta.srcUrl,
      env
    );

    return fresh || null;
  } catch (_) {
    return null;
  }
}

// upstream fetch — Range forward + proxy stream
async function fetchUpstream(
  direct,
  request,
  srcUrl
) {
  const fwdHeaders = new Headers();

  fwdHeaders.set(
    "User-Agent",
    UA
  );

  fwdHeaders.set(
    "Accept",
    "*/*"
  );

  const referer =
    getRefererForSource(
      srcUrl,
      direct
    );

  if (referer) {
    fwdHeaders.set(
      "Referer",
      referer
    );
  }

  const range =
    request.headers.get("Range");

  if (range) {
    fwdHeaders.set(
      "Range",
      range
    );
  }

  return fetch(direct, {
    method: "GET",
    headers: fwdHeaders,
    redirect: "follow",
  });
}

async function fetchHeadSize(
  direct,
  srcUrl
) {
  const fwdHeaders = new Headers();

  fwdHeaders.set(
    "User-Agent",
    UA
  );

  fwdHeaders.set(
    "Accept",
    "*/*"
  );

  fwdHeaders.set(
    "Range",
    "bytes=0-0"
  );

  const referer =
    getRefererForSource(
      srcUrl,
      direct
    );

  if (referer) {
    fwdHeaders.set(
      "Referer",
      referer
    );
  }

  const response = await fetch(
    direct,
    {
      method: "GET",
      headers: fwdHeaders,
      redirect: "follow",
    }
  );

  if (response.body) {
    try {
      await response.body.cancel();
    } catch (_) {}
  }

  if (
    isUpstreamDead(response.status)
  ) {
    return {
      expired: true,
      size: null,
    };
  }

  let size = null;

  const contentRange =
    response.headers.get(
      "content-range"
    );

  if (contentRange) {
    const match =
      contentRange.match(
        /\/(\d+)\s*$/
      );

    if (match) {
      size = match[1];
    }
  }

  if (!size) {
    const contentLength =
      response.headers.get(
        "content-length"
      );

    if (
      contentLength &&
      contentLength !== "1"
    ) {
      size = contentLength;
    }
  }

  return {
    expired: false,
    size,
  };
}

function buildHeadResponse(
  totalSize,
  filename,
  forceDownload
) {
  const headers = new Headers();

  headers.set(
    "Access-Control-Allow-Origin",
    "*"
  );

  headers.set(
    "Accept-Ranges",
    "bytes"
  );

  if (totalSize) {
    headers.set(
      "Content-Length",
      totalSize
    );
  }

  applyDisposition(
    headers,
    filename,
    forceDownload,
    null
  );

  return new Response(null, {
    status: 200,
    headers,
  });
}

function applyDisposition(
  headers,
  filename,
  forceDownload,
  upstream
) {
  if (forceDownload) {
    headers.set(
      "Content-Type",
      "application/octet-stream"
    );

    headers.set(
      "Content-Disposition",
      `attachment; filename="${sanitizeAscii(
        filename
      )}"; ` +
        `filename*=UTF-8''${encodeURIComponent(
          filename
        )}`
    );

    return;
  }

  let contentType = "video/mp4";

  if (upstream) {
    const upstreamType =
      upstream.headers.get(
        "content-type"
      );

    if (
      upstreamType &&
      (
        upstreamType.startsWith(
          "video/"
        ) ||
        upstreamType.includes(
          "mpegurl"
        )
      )
    ) {
      contentType = upstreamType;
    }
  }

  headers.set(
    "Content-Type",
    contentType
  );

  headers.set(
    "Content-Disposition",
    `inline; filename="${sanitizeAscii(
      filename
    )}"; ` +
      `filename*=UTF-8''${encodeURIComponent(
        filename
      )}`
  );
}

function sanitizeAscii(name) {
  return String(
    name || "download.mp4"
  )
    .replace(
      /["\\\r\n]/g,
      "_"
    )
    .replace(
      /[^\x20-\x7E]/g,
      "_"
    );
}

function safeFileName(name) {
  name = String(
    name || ""
  ).trim();

  name = name.replace(
    /[\/\\?%*:|"<>]/g,
    "_"
  );

  name = name.replace(
    /\s+/g,
    "_"
  );

  if (!name) {
    name = "download.mp4";
  }

  if (!name.includes(".")) {
    name += ".mp4";
  }

  return name;
}

function extractFilename(
  srcUrl,
  directUrl
) {
  try {
    const source = new URL(srcUrl);

    const parts = source.pathname
      .split("/")
      .filter(Boolean);

    const last = decodeURIComponent(
      parts[parts.length - 1] || ""
    );

    if (
      last &&
      !/^(?:test|index|get_file|download|play|stream)\.\w+$/i.test(
        last
      ) &&
      last.includes(".")
    ) {
      return safeFileName(last);
    }
  } catch (_) {}

  try {
    const direct = new URL(
      directUrl
    );

    const parts = direct.pathname
      .split("/")
      .filter(Boolean);

    const last = decodeURIComponent(
      parts[parts.length - 1] || ""
    );

    if (
      last &&
      last.includes(".")
    ) {
      return safeFileName(last);
    }
  } catch (_) {}

  return "download.mp4";
}

// ─────────────────────────────────────────────
// Main resolver
// ─────────────────────────────────────────────

async function resolveLink(
  srcUrl,
  env
) {
  // fast-stream direct
  if (isFastStreamUrl(srcUrl)) {
    return srcUrl;
  }

  // gateway link ကို Code 2 behavior အတိုင်း resolve
  if (isMediaGatewayUrl(srcUrl)) {
    const found =
      await resolveMediaGateway(
        srcUrl,
        env
      );

    if (found) {
      return found;
    }

    return srcUrl;
  }

  if (isDirectLink(srcUrl)) {
    return srcUrl;
  }

  if (isJavtifulPageUrl(srcUrl)) {
    const found =
      await resolveJavtiful(
        srcUrl,
        env
      );

    if (found) {
      return found;
    }
  }

  if (isTktubePageUrl(srcUrl)) {
    const found =
      await resolveTktube(
        srcUrl,
        env
      );

    if (found) {
      return found;
    }
  }

  return resolveGeneric(
    srcUrl,
    env
  );
}

function isFastStreamUrl(value) {
  try {
    const url = new URL(value);

    const host =
      url.hostname.toLowerCase();

    const isJavSi =
      host === "jav.si" ||
      host.endsWith(".jav.si");

    return (
      isJavSi &&
      FAST_STREAM_RE.test(
        url.pathname
      )
    );
  } catch (_) {
    return false;
  }
}

function isMediaGatewayUrl(value) {
  try {
    const url = new URL(value);

    const host =
      url.hostname.toLowerCase();

    const isJavtiful =
      host === "javtiful.com" ||
      host.endsWith(
        ".javtiful.com"
      );

    return (
      isJavtiful &&
      MEDIA_GATEWAY_RE.test(
        url.pathname
      )
    );
  } catch (_) {
    return false;
  }
}

function isJavtifulPageUrl(value) {
  try {
    const url = new URL(value);

    const host =
      url.hostname.toLowerCase();

    const isJavtiful =
      host === "javtiful.com" ||
      host.endsWith(
        ".javtiful.com"
      );

    return (
      isJavtiful &&
      /^\/(?:[a-z]{2}\/)?video\/\d+(?:\/|$)/i.test(
        url.pathname
      )
    );
  } catch (_) {
    return false;
  }
}

// Javtiful embed URL စစ်
function isJavtifulEmbedUrl(value) {
  try {
    const url = new URL(value);

    const host =
      url.hostname.toLowerCase();

    const isJavtiful =
      host === "javtiful.com" ||
      host.endsWith(
        ".javtiful.com"
      );

    return (
      isJavtiful &&
      /^\/(?:[a-z]{2}\/)?embed\/\d+(?:\/|$)/i.test(
        url.pathname
      )
    );
  } catch (_) {
    return false;
  }
}

// /video/{id}/... ကနေ /embed/{id} ဆောက်
function getJavtifulEmbedUrl(
  pageUrl
) {
  try {
    const url = new URL(pageUrl);

    const match =
      url.pathname.match(
        /^\/(?:[a-z]{2}\/)?video\/(\d+)(?:\/|$)/i
      );

    if (!match) {
      return null;
    }

    return (
      url.origin +
      "/embed/" +
      encodeURIComponent(match[1])
    );
  } catch (_) {
    return null;
  }
}

// Javtiful embed page fetch
async function fetchJavtifulEmbed(
  embedUrl,
  pageUrl,
  env
) {
  if (!embedUrl) {
    return "";
  }

  const headers =
    buildPageHeaders(
      pageUrl,
      env
    );

  headers.set(
    "Referer",
    pageUrl
  );

  headers.set(
    "Accept",
    "text/html,application/xhtml+xml,application/json,text/plain,*/*"
  );

  try {
    const response = await fetch(
      embedUrl,
      {
        method: "GET",
        headers,
        redirect: "follow",
      }
    );

    const contentType = (
      response.headers.get(
        "content-type"
      ) || ""
    ).toLowerCase();

    if (
      !contentType.includes("text") &&
      !contentType.includes("json") &&
      !contentType.includes(
        "javascript"
      ) &&
      !contentType.includes("html")
    ) {
      if (response.body) {
        try {
          await response.body.cancel();
        } catch (_) {}
      }

      return "";
    }

    return await response.text();
  } catch (_) {
    return "";
  }
}

// media gateway link ကို ဖွင့်ပြီး တကယ့် video link ဆွဲ
async function resolveMediaGateway(
  gatewayUrl,
  env
) {
  const headers =
    buildPageHeaders(
      gatewayUrl,
      env
    );

  headers.set(
    "Accept",
    "*/*"
  );

  headers.set(
    "Range",
    "bytes=0-0"
  );

  let currentUrl = gatewayUrl;

  for (
    let index = 0;
    index < RESOLVE_LIMIT;
    index++
  ) {
    let response;

    try {
      response = await fetch(
        currentUrl,
        {
          method: "GET",
          headers,
          redirect: "manual",
        }
      );
    } catch (_) {
      return null;
    }

    if (
      response.status >= 300 &&
      response.status < 400
    ) {
      if (response.body) {
        try {
          await response.body.cancel();
        } catch (_) {}
      }

      const location =
        response.headers.get(
          "Location"
        );

      if (!location) {
        break;
      }

      const absoluteLocation =
        new URL(
          location,
          currentUrl
        ).toString();

      if (
        isFastStreamUrl(
          absoluteLocation
        )
      ) {
        return absoluteLocation;
      }

      if (
        isDirectLink(
          absoluteLocation
        )
      ) {
        return absoluteLocation;
      }

      currentUrl =
        absoluteLocation;

      continue;
    }

    const contentType = (
      response.headers.get(
        "content-type"
      ) || ""
    ).toLowerCase();

    if (
      contentType.startsWith(
        "video/"
      ) ||
      contentType.includes(
        "mpegurl"
      ) ||
      contentType.startsWith(
        "application/octet-stream"
      )
    ) {
      if (response.body) {
        try {
          await response.body.cancel();
        } catch (_) {}
      }

      return currentUrl;
    }

    if (
      contentType.includes(
        "text/html"
      ) ||
      contentType.includes("json") ||
      contentType.includes(
        "javascript"
      ) ||
      contentType.includes(
        "text/plain"
      )
    ) {
      let text = "";

      try {
        text =
          await response.text();
      } catch (_) {
        text = "";
      }

      const fast =
        extractFastStreamLink(
          text,
          currentUrl
        );

      if (fast) {
        return fast;
      }

      const getFile =
        extractGetFileLink(
          text,
          currentUrl
        );

      if (getFile) {
        return getFile;
      }

      const direct =
        extractDirectFromBody(
          text,
          currentUrl
        );

      if (direct) {
        return direct;
      }

      const candidates =
        extractCandidateUrls(
          text,
          currentUrl
        );

      const fastHit =
        candidates.find(
          isFastStreamUrl
        );

      if (fastHit) {
        return fastHit;
      }

      const directHit =
        candidates.find(
          isDirectLink
        );

      if (directHit) {
        return directHit;
      }

      for (
        let candidateIndex = 0;
        candidateIndex <
          candidates.length &&
        candidateIndex <
          CANDIDATE_BATCH;
        candidateIndex++
      ) {
        const found =
          await resolveCandidate(
            candidates[
              candidateIndex
            ],
            currentUrl,
            env
          ).catch(() => null);

        if (found) {
          return found;
        }
      }

      break;
    }

    if (response.body) {
      try {
        await response.body.cancel();
      } catch (_) {}
    }

    if (
      response.status >= 200 &&
      response.status < 300
    ) {
      return currentUrl;
    }

    break;
  }

  return null;
}

// tktube.com / mmtube.net video page URL စစ်
function isTktubePageUrl(value) {
  try {
    const url = new URL(value);

    const host =
      url.hostname.toLowerCase();

    const isTktube =
      host === "tktube.com" ||
      host.endsWith(
        ".tktube.com"
      ) ||
      host === "mmtube.net" ||
      host.endsWith(
        ".mmtube.net"
      );

    return (
      isTktube &&
      /^\/video\/\d+\//i.test(
        url.pathname
      )
    );
  } catch (_) {
    return false;
  }
}

// tktube / mmtube video page fetch
async function resolveTktube(
  pageUrl,
  env
) {
  const pageHeaders =
    buildPageHeaders(
      pageUrl,
      env
    );

  const response = await fetch(
    pageUrl,
    {
      method: "GET",
      headers: pageHeaders,
      redirect: "follow",
    }
  );

  const contentType = (
    response.headers.get(
      "content-type"
    ) || ""
  ).toLowerCase();

  if (
    contentType.startsWith(
      "video/"
    ) ||
    contentType.startsWith(
      "application/octet-stream"
    )
  ) {
    if (response.body) {
      try {
        await response.body.cancel();
      } catch (_) {}
    }

    return pageUrl;
  }

  let html = "";

  try {
    html = await response.text();
  } catch (_) {
    html = "";
  }

  const getFile =
    extractGetFileLink(
      html,
      pageUrl
    );

  if (getFile) {
    return getFile;
  }

  const direct =
    extractDirectFromBody(
      html,
      pageUrl
    );

  if (direct) {
    return direct;
  }

  const candidates =
    extractCandidateUrls(
      html,
      pageUrl
    );

  const directHit =
    candidates.find(
      isDirectLink
    );

  if (directHit) {
    return directHit;
  }

  for (
    let index = 0;
    index < candidates.length;
    index += CANDIDATE_BATCH
  ) {
    const batch =
      candidates.slice(
        index,
        index + CANDIDATE_BATCH
      );

    const results =
      await Promise.all(
        batch.map((candidate) =>
          resolveCandidate(
            candidate,
            pageUrl,
            env
          ).catch(() => null)
        )
      );

    const hit =
      results.find(Boolean);

    if (hit) {
      return hit;
    }
  }

  return null;
}

// ─────────────────────────────────────────────
// Javtiful resolver
// Main page → embed fallback → gateway/direct
// ─────────────────────────────────────────────

async function resolveJavtiful(
  pageUrl,
  env
) {
  const pageHeaders =
    buildPageHeaders(
      pageUrl,
      env
    );

  let response;

  try {
    response = await fetch(
      pageUrl,
      {
        method: "GET",
        headers: pageHeaders,
        redirect: "follow",
      }
    );
  } catch (_) {
    response = null;
  }

  let html = "";

  if (response) {
    const contentType = (
      response.headers.get(
        "content-type"
      ) || ""
    ).toLowerCase();

    if (
      contentType.startsWith(
        "video/"
      ) ||
      contentType.startsWith(
        "application/octet-stream"
      )
    ) {
      if (response.body) {
        try {
          await response.body.cancel();
        } catch (_) {}
      }

      return pageUrl;
    }

    try {
      html =
        await response.text();
    } catch (_) {
      html = "";
    }
  }

  // 1. Main page ထဲမှာ fast-stream ရှာ
  let fast =
    extractFastStreamLink(
      html,
      pageUrl
    );

  if (fast) {
    return fast;
  }

  // 2. Main page မှာမတွေ့ရင် /embed/{videoId}
  const embedUrl =
    getJavtifulEmbedUrl(
      pageUrl
    );

  if (embedUrl) {
    const embedHtml =
      await fetchJavtifulEmbed(
        embedUrl,
        pageUrl,
        env
      );

    // 2.1 Embed ထဲက fast-stream
    fast =
      extractFastStreamLink(
        embedHtml,
        embedUrl
      );

    if (fast) {
      return fast;
    }

    // 2.2 Embed ထဲက gateway
    const embedGateway =
      extractMediaGatewayLink(
        embedHtml,
        embedUrl
      );

    if (embedGateway) {
      const real =
        await resolveMediaGateway(
          embedGateway,
          env
        );

      if (real) {
        return real;
      }

      return embedGateway;
    }

    // 2.3 Embed ထဲက legacy/direct
    const embedDirect =
      extractDirectFromBody(
        embedHtml,
        embedUrl
      );

    if (embedDirect) {
      return embedDirect;
    }

    // 2.4 Embed candidate links
    const embedCandidates =
      extractCandidateUrls(
        embedHtml,
        embedUrl
      );

    const embedFastHit =
      embedCandidates.find(
        isFastStreamUrl
      );

    if (embedFastHit) {
      return embedFastHit;
    }

    const embedDirectHit =
      embedCandidates.find(
        isDirectLink
      );

    if (embedDirectHit) {
      return embedDirectHit;
    }

    const embedGatewayHit =
      embedCandidates.find(
        isMediaGatewayUrl
      );

    if (embedGatewayHit) {
      const real =
        await resolveMediaGateway(
          embedGatewayHit,
          env
        );

      if (real) {
        return real;
      }

      return embedGatewayHit;
    }

    for (
      let index = 0;
      index <
      embedCandidates.length;
      index += CANDIDATE_BATCH
    ) {
      const batch =
        embedCandidates.slice(
          index,
          index +
            CANDIDATE_BATCH
        );

      const results =
        await Promise.all(
          batch.map((candidate) =>
            resolveCandidate(
              candidate,
              embedUrl,
              env
            ).catch(() => null)
          )
        );

      const hit =
        results.find(Boolean);

      if (hit) {
        return hit;
      }
    }
  }

  // 3. Main page gateway engine
  const gateway =
    extractMediaGatewayLink(
      html,
      pageUrl
    );

  if (gateway) {
    const real =
      await resolveMediaGateway(
        gateway,
        env
      );

    if (real) {
      return real;
    }

    return gateway;
  }

  // 4. Main page legacy R2/direct
  const direct =
    extractDirectFromBody(
      html,
      pageUrl
    );

  if (direct) {
    return direct;
  }

  const candidates =
    extractCandidateUrls(
      html,
      pageUrl
    );

  const fastHit =
    candidates.find(
      isFastStreamUrl
    );

  if (fastHit) {
    return fastHit;
  }

  const directHit =
    candidates.find(
      isDirectLink
    );

  if (directHit) {
    return directHit;
  }

  const gatewayHit =
    candidates.find(
      isMediaGatewayUrl
    );

  if (gatewayHit) {
    const real =
      await resolveMediaGateway(
        gatewayHit,
        env
      );

    if (real) {
      return real;
    }

    return gatewayHit;
  }

  for (
    let index = 0;
    index < candidates.length;
    index += CANDIDATE_BATCH
  ) {
    const batch =
      candidates.slice(
        index,
        index + CANDIDATE_BATCH
      );

    const results =
      await Promise.all(
        batch.map((candidate) =>
          resolveCandidate(
            candidate,
            pageUrl,
            env
          ).catch(() => null)
        )
      );

    const hit =
      results.find(Boolean);

    if (hit) {
      return hit;
    }
  }

  return null;
}

// fast-stream link ကို HTML/JS ကနေ ဆွဲထုတ်
function extractFastStreamLink(
  text,
  baseUrl
) {
  if (!text) {
    return null;
  }

  const source =
    normalizeSource(text);

  // Absolute fast-stream URL
  const absoluteRegex =
    /https?:\/\/fast-stream\.jav\.si\/p\/[0-9a-f]{4,}(?:-[0-9a-f]{2,})+\/?(?:\?[^\s"'\\<>()]*)?/gi;

  const absoluteMatches =
    source.match(
      absoluteRegex
    );

  if (
    absoluteMatches &&
    absoluteMatches.length
  ) {
    const links =
      absoluteMatches
        .map(cleanUrl)
        .filter(isFastStreamUrl)
        .sort(
          (first, second) =>
            second.length -
            first.length
        );

    if (links.length) {
      return links[0];
    }
  }

  // JSON / quoted string fallback
  const quotedRegex =
    /["']([^"']*fast-stream\.jav\.si\/p\/[^"']+)["']/gi;

  let match;

  while (
    (match =
      quotedRegex.exec(source)) !==
    null
  ) {
    let candidate =
      cleanUrl(match[1]);

    if (
      !/^https?:\/\//i.test(
        candidate
      )
    ) {
      candidate =
        "https://" + candidate;
    }

    if (
      isFastStreamUrl(candidate)
    ) {
      return candidate;
    }
  }

  // Relative /p/{hash-chain}
  const relativeRegex =
    /["'](\/p\/[0-9a-f]{4,}(?:-[0-9a-f]{2,})+\/?(?:\?[^"']*)?)["']/gi;

  while (
    (match =
      relativeRegex.exec(source)) !==
    null
  ) {
    try {
      let origin =
        "https://fast-stream.jav.si";

      if (baseUrl) {
        const base =
          new URL(baseUrl);

        if (
          base.hostname.toLowerCase() ===
          "fast-stream.jav.si"
        ) {
          origin = base.origin;
        }
      }

      const candidate =
        new URL(
          match[1],
          origin
        ).toString();

      if (
        isFastStreamUrl(candidate)
      ) {
        return candidate;
      }
    } catch (_) {}
  }

  return null;
}

// tktube / mmtube get_file link
function extractGetFileLink(
  text,
  baseUrl
) {
  if (!text) {
    return null;
  }

  const source =
    normalizeSource(text);

  let origin = "";

  try {
    origin =
      new URL(baseUrl).origin;
  } catch (_) {}

  const absoluteRegex =
    /https?:\/\/[^\s"'\\<>()]+\/get_file\/[^\s"'\\<>()]+/gi;

  const absoluteMatches =
    source.match(
      absoluteRegex
    );

  if (
    absoluteMatches &&
    absoluteMatches.length
  ) {
    const best =
      absoluteMatches
        .map(cleanUrl)
        .sort(
          (first, second) =>
            second.length -
            first.length
        )[0];

    if (best) {
      return best;
    }
  }

  if (origin) {
    const relativeRegex =
      /["'](\/get_file\/[^\s"'\\<>()]+)["']/gi;

    let match;
    let best = "";

    while (
      (match =
        relativeRegex.exec(
          source
        )) !== null
    ) {
      const candidate =
        cleanUrl(match[1]);

      if (
        candidate.length >
        best.length
      ) {
        best = candidate;
      }
    }

    if (best) {
      return origin + best;
    }
  }

  return null;
}

// Javtiful gateway link extract
function extractMediaGatewayLink(
  text,
  baseUrl
) {
  if (!text) {
    return null;
  }

  const source =
    normalizeSource(text);

  let origin = "";

  try {
    origin =
      new URL(baseUrl).origin;
  } catch (_) {}

  const absoluteRegex =
    /https?:\/\/[^\s"'\\<>()]+\/media\/video\/\d+\/[^\s"'\\<>()]+/gi;

  const absoluteMatches =
    source.match(
      absoluteRegex
    );

  if (
    absoluteMatches &&
    absoluteMatches.length
  ) {
    const links =
      absoluteMatches
        .map(cleanUrl)
        .filter(
          isMediaGatewayUrl
        )
        .sort(
          (first, second) =>
            second.length -
            first.length
        );

    if (links.length) {
      return links[0];
    }
  }

  if (origin) {
    const relativeRegex =
      /["'](\/media\/video\/\d+\/[^\s"'\\<>()]+)["']/gi;

    let match;
    let best = "";

    while (
      (match =
        relativeRegex.exec(
          source
        )) !== null
    ) {
      const candidate =
        cleanUrl(match[1]);

      if (
        candidate.length >
        best.length
      ) {
        best = candidate;
      }
    }

    if (best) {
      const absolute =
        origin + best;

      if (
        isMediaGatewayUrl(
          absolute
        )
      ) {
        return absolute;
      }
    }
  }

  return null;
}

async function resolveCandidate(
  candidateUrl,
  refererUrl,
  env
) {
  if (
    isFastStreamUrl(
      candidateUrl
    )
  ) {
    return candidateUrl;
  }

  if (
    isDirectLink(candidateUrl)
  ) {
    return candidateUrl;
  }

  const headers =
    buildPageHeaders(
      refererUrl,
      env
    );

  headers.set(
    "X-Requested-With",
    "XMLHttpRequest"
  );

  headers.set(
    "Accept",
    "application/json,text/plain,text/html,*/*"
  );

  let currentUrl =
    candidateUrl;

  for (
    let index = 0;
    index < RESOLVE_LIMIT;
    index++
  ) {
    let response;

    try {
      response = await fetch(
        currentUrl,
        {
          method: "GET",
          headers,
          redirect: "manual",
        }
      );
    } catch (_) {
      return null;
    }

    if (
      response.status >= 300 &&
      response.status < 400
    ) {
      if (response.body) {
        try {
          await response.body.cancel();
        } catch (_) {}
      }

      const location =
        response.headers.get(
          "Location"
        );

      if (!location) {
        return null;
      }

      const absoluteLocation =
        new URL(
          location,
          currentUrl
        ).toString();

      if (
        isFastStreamUrl(
          absoluteLocation
        )
      ) {
        return absoluteLocation;
      }

      if (
        isDirectLink(
          absoluteLocation
        )
      ) {
        return absoluteLocation;
      }

      currentUrl =
        absoluteLocation;

      continue;
    }

    const contentType = (
      response.headers.get(
        "content-type"
      ) || ""
    ).toLowerCase();

    if (
      contentType.startsWith(
        "video/"
      ) ||
      contentType.includes(
        "mpegurl"
      ) ||
      contentType.startsWith(
        "application/octet-stream"
      )
    ) {
      if (response.body) {
        try {
          await response.body.cancel();
        } catch (_) {}
      }

      return currentUrl;
    }

    if (
      isDirectLink(currentUrl)
    ) {
      if (response.body) {
        try {
          await response.body.cancel();
        } catch (_) {}
      }

      return currentUrl;
    }

    let text = "";

    try {
      text =
        await response.text();
    } catch (_) {
      text = "";
    }

    const fast =
      extractFastStreamLink(
        text,
        currentUrl
      );

    if (fast) {
      return fast;
    }

    const gateway =
      extractMediaGatewayLink(
        text,
        currentUrl
      );

    if (gateway) {
      const real =
        await resolveMediaGateway(
          gateway,
          env
        );

      if (real) {
        return real;
      }

      return gateway;
    }

    const getFile =
      extractGetFileLink(
        text,
        currentUrl
      );

    if (getFile) {
      return getFile;
    }

    const direct =
      extractDirectFromBody(
        text,
        currentUrl
      );

    if (direct) {
      return direct;
    }

    const more =
      extractCandidateUrls(
        text,
        currentUrl
      );

    for (
      const candidate of
      more.slice(0, 5)
    ) {
      if (
        isFastStreamUrl(
          candidate
        )
      ) {
        return candidate;
      }

      if (
        isDirectLink(candidate)
      ) {
        return candidate;
      }

      if (
        isMediaGatewayUrl(
          candidate
        )
      ) {
        const real =
          await resolveMediaGateway(
            candidate,
            env
          );

        if (real) {
          return real;
        }

        return candidate;
      }
    }

    break;
  }

  return null;
}

// Generic resolver
async function resolveGeneric(
  srcUrl,
  env
) {
  const headers =
    buildPageHeaders(
      srcUrl,
      env
    );

  let currentUrl = srcUrl;

  for (
    let index = 0;
    index < RESOLVE_LIMIT;
    index++
  ) {
    if (
      isFastStreamUrl(
        currentUrl
      )
    ) {
      return currentUrl;
    }

    let headResponse;

    try {
      headResponse = await fetch(
        currentUrl,
        {
          method: "HEAD",
          headers,
          redirect: "manual",
        }
      );
    } catch (_) {
      headResponse = null;
    }

    const headUnsupported =
      !headResponse ||
      headResponse.status === 405 ||
      headResponse.status === 501 ||
      headResponse.status === 400;

    if (
      !headUnsupported &&
      headResponse.status >= 300 &&
      headResponse.status < 400
    ) {
      const location =
        headResponse.headers.get(
          "Location"
        );

      if (location) {
        const absoluteLocation =
          new URL(
            location,
            currentUrl
          ).toString();

        if (
          isFastStreamUrl(
            absoluteLocation
          ) ||
          isDirectLink(
            absoluteLocation
          )
        ) {
          return absoluteLocation;
        }

        currentUrl =
          absoluteLocation;

        continue;
      }
    }

    if (!headUnsupported) {
      if (
        headResponse.status >= 200 &&
        headResponse.status < 300 &&
        isDirectLink(currentUrl)
      ) {
        return currentUrl;
      }

      const contentType = (
        headResponse.headers.get(
          "content-type"
        ) || ""
      ).toLowerCase();

      if (
        headResponse.status >= 200 &&
        headResponse.status < 300 &&
        (
          contentType.startsWith(
            "video/"
          ) ||
          contentType.includes(
            "mpegurl"
          ) ||
          contentType.startsWith(
            "application/octet-stream"
          )
        )
      ) {
        return currentUrl;
      }
    }

    let getResponse;

    try {
      getResponse = await fetch(
        currentUrl,
        {
          method: "GET",
          headers,
          redirect: "manual",
        }
      );
    } catch (_) {
      break;
    }

    if (
      getResponse.status >= 300 &&
      getResponse.status < 400
    ) {
      if (getResponse.body) {
        try {
          await getResponse.body.cancel();
        } catch (_) {}
      }

      const location =
        getResponse.headers.get(
          "Location"
        );

      if (!location) {
        break;
      }

      const absoluteLocation =
        new URL(
          location,
          currentUrl
        ).toString();

      if (
        isFastStreamUrl(
          absoluteLocation
        ) ||
        isDirectLink(
          absoluteLocation
        )
      ) {
        return absoluteLocation;
      }

      currentUrl =
        absoluteLocation;

      continue;
    }

    if (
      isDirectLink(currentUrl)
    ) {
      if (getResponse.body) {
        try {
          await getResponse.body.cancel();
        } catch (_) {}
      }

      return currentUrl;
    }

    const contentType = (
      getResponse.headers.get(
        "content-type"
      ) || ""
    ).toLowerCase();

    if (
      contentType.startsWith(
        "video/"
      ) ||
      contentType.includes(
        "mpegurl"
      ) ||
      contentType.startsWith(
        "application/octet-stream"
      )
    ) {
      if (getResponse.body) {
        try {
          await getResponse.body.cancel();
        } catch (_) {}
      }

      return currentUrl;
    }

    if (
      contentType.includes(
        "text/html"
      ) ||
      contentType.includes(
        "javascript"
      ) ||
      contentType.includes(
        "json"
      ) ||
      contentType.includes(
        "text/plain"
      )
    ) {
      let bodyText = "";

      try {
        bodyText =
          await getResponse.text();
      } catch (_) {
        bodyText = "";
      }

      const fast =
        extractFastStreamLink(
          bodyText,
          currentUrl
        );

      if (fast) {
        return fast;
      }

      const gateway =
        extractMediaGatewayLink(
          bodyText,
          currentUrl
        );

      if (gateway) {
        const real =
          await resolveMediaGateway(
            gateway,
            env
          );

        if (real) {
          return real;
        }

        return gateway;
      }

      const getFile =
        extractGetFileLink(
          bodyText,
          currentUrl
        );

      if (getFile) {
        return getFile;
      }

      const direct =
        extractDirectFromBody(
          bodyText,
          currentUrl
        );

      if (direct) {
        return direct;
      }

      const candidates =
        extractCandidateUrls(
          bodyText,
          currentUrl
        );

      const fastHit =
        candidates.find(
          isFastStreamUrl
        );

      if (fastHit) {
        return fastHit;
      }

      const directHit =
        candidates.find(
          isDirectLink
        );

      if (directHit) {
        return directHit;
      }

      const gatewayHit =
        candidates.find(
          isMediaGatewayUrl
        );

      if (gatewayHit) {
        const real =
          await resolveMediaGateway(
            gatewayHit,
            env
          );

        if (real) {
          return real;
        }

        return gatewayHit;
      }

      for (
        let candidateIndex = 0;
        candidateIndex <
          candidates.length &&
        candidateIndex <
          CANDIDATE_BATCH;
        candidateIndex++
      ) {
        const found =
          await resolveCandidate(
            candidates[
              candidateIndex
            ],
            currentUrl,
            env
          ).catch(() => null);

        if (found) {
          return found;
        }
      }
    } else if (getResponse.body) {
      try {
        await getResponse.body.cancel();
      } catch (_) {}
    }

    break;
  }

  return null;
}

function buildPageHeaders(
  url,
  env
) {
  const headers = new Headers();

  headers.set(
    "User-Agent",
    UA
  );

  headers.set(
    "Accept",
    "text/html,application/xhtml+xml,application/xml;q=0.9,application/json,text/plain,*/*;q=0.8"
  );

  headers.set(
    "Accept-Language",
    "en-US,en;q=0.9"
  );

  headers.set(
    "Cache-Control",
    "no-cache"
  );

  headers.set(
    "Pragma",
    "no-cache"
  );

  const referer =
    getRefererForSource(url);

  if (referer) {
    headers.set(
      "Referer",
      referer
    );
  }

  if (
    env &&
    env.JAVTIFUL_COOKIE &&
    (
      isJavtifulPageUrl(url) ||
      isJavtifulEmbedUrl(url) ||
      isMediaGatewayUrl(url) ||
      isFastStreamUrl(url)
    )
  ) {
    headers.set(
      "Cookie",
      env.JAVTIFUL_COOKIE
    );
  }

  if (
    env &&
    env.SITE_COOKIE &&
    !isJavtifulPageUrl(url) &&
    !isJavtifulEmbedUrl(url) &&
    !isMediaGatewayUrl(url) &&
    !isFastStreamUrl(url)
  ) {
    headers.set(
      "Cookie",
      env.SITE_COOKIE
    );
  }

  return headers;
}

function getRefererForSource(
  srcUrl,
  directUrl = ""
) {
  if (
    isFastStreamUrl(srcUrl) ||
    isFastStreamUrl(directUrl)
  ) {
    return "https://javtiful.com/";
  }

  try {
    const url = new URL(
      srcUrl || directUrl
    );

    return url.origin + "/";
  } catch (_) {}

  try {
    const direct =
      new URL(directUrl);

    return direct.origin + "/";
  } catch (_) {}

  return "https://google.com/";
}

function isDirectLink(value) {
  if (!value) {
    return false;
  }

  if (isFastStreamUrl(value)) {
    return true;
  }

  if (
    isMediaGatewayUrl(value)
  ) {
    return false;
  }

  if (
    DIRECT_HOST_RE.test(value)
  ) {
    return true;
  }

  try {
    const url = new URL(value);

    if (
      /\/get_file\//i.test(
        url.pathname
      )
    ) {
      return true;
    }

    if (
      DIRECT_PATH_RE.test(
        url.pathname
      ) &&
      /[?&](?:token|fileid|file_id|fid|key|id|acctoken|v-acctoken)=/i.test(
        url.search
      )
    ) {
      return true;
    }

    if (
      /\.(?:mp4|m3u8|ts)\//i.test(
        url.pathname
      )
    ) {
      return true;
    }
  } catch (_) {}

  return (
    /X-Amz-Signature=/i.test(
      value
    ) ||
    /X-Amz-Credential=/i.test(
      value
    ) ||
    /r2\.cloudflarestorage\.com/i.test(
      value
    ) ||
    /(?:^|\.)r2\.dev\//i.test(
      value
    ) ||
    /cloudflarestream\.com/i.test(
      value
    ) ||
    /[?&](?:expires|e|exp|signature|sign|token|hash|md5|acctoken|v-acctoken)=/i.test(
      value
    ) ||
    /\.(?:mp4|m3u8|ts)(?:[?#/]|$)/i.test(
      value
    )
  );
}

function extractDirectFromBody(
  text,
  baseUrl,
  depth = 0
) {
  if (!text) {
    return null;
  }

  const source =
    normalizeSource(text);

  // fast-stream ကို direct extractor ကနေလည်း စစ်
  const fast =
    extractFastStreamLink(
      source,
      baseUrl
    );

  if (fast) {
    return fast;
  }

  const storageRegex =
    /https?:\/\/[^\s"'\\<>()]+(?:(?:r2\.cloudflarestorage\.com)|(?:\.r2\.dev)|(?:cloudflarestream\.com)|(?:qyshare\.com)|(?:\/get_file\/)|(?:\.mp4)|(?:\.m3u8))[^\s"'\\<>()]*/gi;

  const storageMatches =
    source.match(storageRegex);

  if (
    storageMatches &&
    storageMatches.length
  ) {
    const links =
      storageMatches
        .map(cleanUrl)
        .filter(Boolean)
        .sort(
          (first, second) =>
            second.length -
            first.length
        );

    const direct =
      links.find(
        isDirectLink
      );

    if (direct) {
      return direct;
    }
  }

  const signedRegex =
    /https?:\/\/[^\s"'\\<>()]+(?:X-Amz-Signature=|X-Amz-Credential=|[?&](?:expires|signature|sign|token|hash|md5|acctoken|v-acctoken)=)[^\s"'\\<>()]*/gi;

  const signedMatches =
    source.match(signedRegex);

  if (
    signedMatches &&
    signedMatches.length
  ) {
    const links =
      signedMatches
        .map(cleanUrl)
        .filter(
          (link) =>
            link &&
            !isMediaGatewayUrl(
              link
            )
        )
        .sort(
          (first, second) =>
            second.length -
            first.length
        );

    const direct =
      links.find(
        isDirectLink
      );

    if (direct) {
      return direct;
    }
  }

  const fileRegex =
    /(?:file|src|url|source|videoUrl|video_url|stream|stream_url|hls|hlsUrl|playlist)\s*[:=]\s*["']([^"']+(?:\.(?:mp4|m3u8)|\/get_file\/)[^"']*)["']/gi;

  let match;

  while (
    (match =
      fileRegex.exec(source)) !==
    null
  ) {
    try {
      const absolute =
        new URL(
          match[1],
          baseUrl
        ).toString();

      if (
        isDirectLink(absolute)
      ) {
        return cleanUrl(
          absolute
        );
      }
    } catch (_) {}
  }

  const quotedUrlRegex =
    /["'](https?:\/\/[^"']+(?:\.(?:mp4|m3u8)(?:\?[^"']*)?|\/get_file\/[^"']*))["']/gi;

  while (
    (match =
      quotedUrlRegex.exec(
        source
      )) !== null
  ) {
    const direct =
      cleanUrl(match[1]);

    if (
      isDirectLink(direct)
    ) {
      return direct;
    }
  }

  if (depth < 1) {
    const base64Regex =
      /["']([A-Za-z0-9+/=]{80,})["']/g;

    let encodedMatch;

    while (
      (encodedMatch =
        base64Regex.exec(
          source
        )) !== null
    ) {
      try {
        const decoded = atob(
          encodedMatch[1]
        );

        if (
          /https?:\/\//i.test(
            decoded
          )
        ) {
          const direct =
            extractDirectFromBody(
              decoded,
              baseUrl,
              depth + 1
            );

          if (direct) {
            return direct;
          }
        }
      } catch (_) {}
    }
  }

  return null;
}

function extractCandidateUrls(
  text,
  baseUrl
) {
  const output = [];
  const seen = new Set();

  if (!text) {
    return output;
  }

  const source =
    normalizeSource(text);

  function add(value) {
    try {
      if (!value) {
        return;
      }

      if (
        /^(javascript:|data:|mailto:|tel:)/i.test(
          value
        )
      ) {
        return;
      }

      const absolute =
        new URL(
          value,
          baseUrl
        ).toString();

      if (seen.has(absolute)) {
        return;
      }

      seen.add(absolute);

      if (
        isFastStreamUrl(
          absolute
        )
      ) {
        output.push(absolute);
        return;
      }

      if (
        isDirectLink(absolute)
      ) {
        output.push(absolute);
        return;
      }

      if (
        isMediaGatewayUrl(
          absolute
        )
      ) {
        output.push(absolute);
        return;
      }

      const parsed =
        new URL(absolute);

      const path =
        parsed.pathname.toLowerCase();

      const query =
        parsed.search.toLowerCase();

      if (
        /\/(?:api|ajax|source|sources|stream|streams|player|playlist|download|embed|hls|m3u8|get_file|media)\b/i.test(
          path
        ) ||
        /(?:source|stream|video|file|token|download|hls)/i.test(
          query
        )
      ) {
        output.push(absolute);
      }
    } catch (_) {}
  }

  const quotedRegex =
    /["']([^"']{1,2000})["']/g;

  let match;

  while (
    (match =
      quotedRegex.exec(source)) !==
    null
  ) {
    const value =
      match[1].trim();

    if (
      /^https?:\/\//i.test(
        value
      ) ||
      /^\/[A-Za-z0-9_\-./?=&%]+/i.test(
        value
      )
    ) {
      add(value);
    }
  }

  const attributeRegex =
    /(?:href|src|data-src|data-url|data-video|data-file|data-stream|data-source|data-player)\s*=\s*["']([^"']+)["']/gi;

  while (
    (match =
      attributeRegex.exec(
        source
      )) !== null
  ) {
    add(match[1]);
  }

  output.sort(
    (first, second) => {
      const firstPriority =
        isFastStreamUrl(first)
          ? 0
          : isDirectLink(first)
            ? 1
            : isMediaGatewayUrl(
                  first
                )
              ? 2
              : 3;

      const secondPriority =
        isFastStreamUrl(second)
          ? 0
          : isDirectLink(second)
            ? 1
            : isMediaGatewayUrl(
                  second
                )
              ? 2
              : 3;

      return (
        firstPriority -
        secondPriority
      );
    }
  );

  return output.slice(
    0,
    CANDIDATE_CAP
  );
}

function normalizeSource(text) {
  return String(text || "")
    .replace(/\\\//g, "/")
    .replace(
      /\\u0026/gi,
      "&"
    )
    .replace(
      /\\u003d/gi,
      "="
    )
    .replace(
      /\\u003a/gi,
      ":"
    )
    .replace(
      /\\u002f/gi,
      "/"
    )
    .replace(
      /&amp;/gi,
      "&"
    )
    .replace(
      /&#038;/gi,
      "&"
    );
}

function cleanUrl(value) {
  return String(value || "")
    .replace(
      /[)"';\\]+$/g,
      ""
    )
    .replace(
      /&amp;/gi,
      "&"
    )
    .replace(
      /&#038;/gi,
      "&"
    )
    .trim();
}

function getErrorMessage(error) {
  if (!error) {
    return "Unknown error";
  }

  return (
    error.message ||
    String(error)
  );
}
