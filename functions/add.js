// functions/add.js
// tktube get_file link ပို့ → ID ထုတ်ပေး → permanent download link ပြန်ပေး
// ★ custom filename support (filename ကို URL path ထဲ ထည့်)
// ★★★ auth required — login မဝင်ဘဲ သုံးလို့မရ ★★★

import { isAuthenticated } from "./_shared/auth.js";

export async function onRequest(context) {
  const { request, env } = context;

  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json; charset=utf-8",
  };

  // ★★★ အရင်ဆုံး login စစ် — မဝင်ထားရင် ဘာမှ မလုပ်ဘူး ★★★
  if (!(await isAuthenticated(request, env))) {
    return new Response(
      JSON.stringify({ error: "ဝင်ရောက်ခွင့်မရှိပါ — login အရင်ဝင်ပါ" }),
      { status: 401, headers: cors }
    );
  }

  const url = new URL(request.url);
  const srcUrl = url.searchParams.get("url");
  const customName = url.searchParams.get("name"); // ★ optional

  // ★ tktube get_file link ပိုတိကျအောင် စစ်
  if (!srcUrl || !/^https?:\/\/(www\.)?tktube\.com\/get_file\//i.test(srcUrl)) {
    return new Response(
      JSON.stringify({ error: "tktube get_file link မှန်မှန်ထည့်ပါ" }),
      { status: 400, headers: cors }
    );
  }

  // ★ ID collision မဖြစ်အောင် UUID အခြေခံ (8 လုံး)
  const id = crypto.randomUUID().replace(/-/g, "").substring(0, 8);

  // KV မှာ သိမ်း
  await env.LINKS.put(id, srcUrl);

  // ★ custom filename ရှိရင် သိမ်း
  let finalName = "";
  if (customName && customName.trim()) {
    finalName = customName.trim();
    await env.LINKS.put("name:" + id, finalName);
  }

  // ★ link ဆောက်နည်း — download manager က path နောက်ဆုံးအပိုင်းကို filename ယူ
  let downloadLink;
  if (finalName) {
    let nameForUrl = finalName;
    if (!nameForUrl.includes(".")) nameForUrl += ".mp4";
    downloadLink = `${url.origin}/v/${id}/${encodeURIComponent(nameForUrl)}`;
  } else {
    downloadLink = `${url.origin}/v/${id}.mp4`;
  }

  return new Response(
    JSON.stringify({ id, link: downloadLink, name: finalName || null }),
    { headers: cors }
  );
}
