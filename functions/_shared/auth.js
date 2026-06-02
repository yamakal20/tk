// functions/_shared/auth.js
// ★ password hash + signed cookie (HMAC) helper — ပြန်သုံးနိုင်အောင် စုထား

const COOKIE_NAME = "mf_auth";
const SESSION_TTL = 60 * 60 * 24 * 7; // 7 ရက် (စက္ကန့်)

// ───────────────────────────────────────────────
// string → ArrayBuffer
function enc(str) {
  return new TextEncoder().encode(str);
}

// ArrayBuffer → hex string
function bufToHex(buf) {
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ★ timing-safe string compare (length leak ကာကွယ်)
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// ───────────────────────────────────────────────
// password ကို SHA-256 hash
export async function hashPassword(password) {
  const digest = await crypto.subtle.digest("SHA-256", enc(password));
  return bufToHex(digest);
}

// ───────────────────────────────────────────────
// HMAC-SHA256 sign (cookie token အတွက်)
async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    enc(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc(message));
  return bufToHex(sig);
}

// ───────────────────────────────────────────────
// ★ login အောင်မြင်ရင် token ထုတ် — payload: "exp.signature"
export async function createSessionToken(secret) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL;
  const payload = String(exp);
  const sig = await hmac(secret, payload);
  return `${payload}.${sig}`;
}

// ───────────────────────────────────────────────
// ★ token မှန်/မမှန် စစ် (signature + expiry)
export async function verifySessionToken(token, secret) {
  if (!token || typeof token !== "string") return false;
  const dot = token.lastIndexOf(".");
  if (dot < 0) return false;

  const payload = token.substring(0, dot);
  const sig = token.substring(dot + 1);

  // signature ပြန်တွက်ပြီး တိုက်စစ် (forge ကာကွယ်)
  const expected = await hmac(secret, payload);
  if (!safeEqual(sig, expected)) return false;

  // expiry စစ်
  const exp = parseInt(payload, 10);
  if (!exp || Date.now() / 1000 > exp) return false;

  return true;
}

// ───────────────────────────────────────────────
// request ထဲက cookie ကနေ login ဝင်ပြီးသားလား စစ်
export async function isAuthenticated(request, env) {
  if (!env.AUTH_SECRET) return false;
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(new RegExp(COOKIE_NAME + "=([^;]+)"));
  if (!m) return false;
  return await verifySessionToken(decodeURIComponent(m[1]), env.AUTH_SECRET);
}

// ───────────────────────────────────────────────
// ★ login အောင်မြင်ရင် ပြန်ပေးမယ့် Set-Cookie header value
export function buildAuthCookie(token) {
  // HttpOnly: JS မဖတ်နိုင် (XSS ကာကွယ်)
  // Secure: HTTPS သာ
  // SameSite=Strict: CSRF ကာကွယ်
  return (
    `${COOKIE_NAME}=${encodeURIComponent(token)}; ` +
    `Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL}`
  );
}

// logout cookie (clear)
export function clearAuthCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}
