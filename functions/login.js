// functions/login.js
// ★ password စစ် → အောင်မြင်ရင် signed cookie ပေး

import {
  hashPassword,
  createSessionToken,
  buildAuthCookie,
} from "./_shared/auth.js";

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method !== "POST") {
    return json({ error: "POST only" }, 405);
  }

  // server မှာ password set မထားရင်
  if (!env.SITE_PASSWORD || !env.AUTH_SECRET) {
    return json({ error: "Server config မပြည့်စုံပါ" }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ error: "Invalid request" }, 400);
  }

  const password = (body && body.password) || "";

  // ★ hash ၂ ခု တိုက်စစ် (timing-safe ဖြစ်အောင် hash level မှာ နှိုင်း)
  const inputHash = await hashPassword(password);
  const realHash = await hashPassword(env.SITE_PASSWORD);

  if (inputHash !== realHash) {
    // ★ brute-force နှေးအောင် အနည်းငယ် delay
    await new Promise((r) => setTimeout(r, 500));
    return json({ error: "Password မှားနေပါတယ်" }, 401);
  }

  // အောင်မြင် → token ထုတ်ပြီး cookie ပေး
  const token = await createSessionToken(env.AUTH_SECRET);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": buildAuthCookie(token),
    },
  });
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
