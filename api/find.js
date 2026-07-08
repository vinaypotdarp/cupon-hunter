// CouponHunter V2 — multi-provider serverless API
// Modes: ?mode=expand&q=...  |  ?mode=find&store=..&provider=..&product=..  |  POST mode=best
// Env: GEMINI_API_KEY

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const MODELS = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-flash"];

const PROVIDERS = {
  coupondunia: s => [`https://www.coupondunia.in/${s}`],
  grabon: s => [`https://www.grabon.in/${s}-coupons/`],
  desidime: s => [`https://www.desidime.com/stores/${s}`],
  wethrift: s => [`https://www.wethrift.com/${s}`],
};

function strip(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#\d+;/g, " ").replace(/\s{2,}/g, " ").trim();
}

async function grab(url, ms = 8000) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html", "Accept-Language": "en-IN,en;q=0.9" }, redirect: "follow", signal: c.signal });
    if (!r.ok) return null;
    return { url, text: strip(await r.text()).slice(0, 12000) };
  } catch { return null; } finally { clearTimeout(t); }
}

async function ddg(q, n = 2) {
  try {
    const r = await fetch("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(q), { headers: { "User-Agent": UA } });
    const h = await r.text(); const urls = []; const re = /uddg=([^&"]+)/g; let m;
    while ((m = re.exec(h)) && urls.length < n) { try { const u = decodeURIComponent(m[1]); if (u.startsWith("http") && !urls.includes(u)) urls.push(u); } catch {} }
    return urls;
  } catch { return []; }
}

async function gemini(key, prompt) {
  let err = "";
  for (const model of MODELS) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.1, responseMimeType: "application/json" } }),
      });
      if (r.status === 404) continue;
      const j = await r.json();
      if (j.error) { err = j.error.message || "err"; if (/quota|rate/i.test(err)) break; continue; }
      return (j.candidates?.[0]?.content?.parts || []).map(p => p.text).join("");
    } catch (e) { err = String(e.message || e); }
  }
  throw new Error(err || "AI failed");
}

function pluck(text, open, close) {
  const a = text.indexOf(open), b = text.lastIndexOf(close);
  if (a === -1 || b <= a) return null;
  try { return JSON.parse(text.slice(a, b + 1)); } catch { return null; }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=1800");
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: "GEMINI_API_KEY not set in Vercel." });
  const q = req.query || {};
  const mode = q.mode || (req.body && req.body.mode) || "find";
  const today = new Date().toDateString();

  try {
    if (mode === "expand") {
      const text = await gemini(key,
        `User typed a shopping search: "${String(q.q || "").slice(0, 120)}". Today is ${today}. Region: India.\n` +
        `Return ONLY JSON: {"product":"product name or null if it's just a store","stores":["up to 3 lowercase store/brand slugs most relevant to buy this from in India, e.g. myntra, flipkart, nike, amazon"]}. ` +
        `If the query IS a store/brand, its slug must be first in stores.`);
      return res.status(200).json(pluck(text, "{", "}") || { product: null, stores: [String(q.q || "").toLowerCase().replace(/[^a-z0-9]+/g, "-")] });
    }

    if (mode === "best" && req.method === "POST") {
      const b = req.body || {};
      const text = await gemini(key,
        `You are a savings advisor. Today is ${today}. The user searched "${b.query}". Here are coupons found (JSON): ${JSON.stringify(b.coupons || []).slice(0, 9000)}\n` +
        `Pick the single best way to save (biggest realistic saving, prefer verified & unexpired). Return ONLY JSON: {"headline":"short punchy recommendation","store":"store","code":"code or null","reason":"1 sentence why this beats the rest"}.`);
      return res.status(200).json(pluck(text, "{", "}") || {});
    }

    // mode=find — one provider, one store, per request (frontend fans out in parallel)
    const store = String(q.store || "").trim().toLowerCase();
    const provider = String(q.provider || "ddg");
    const product = String(q.product || "").trim();
    if (!store) return res.status(400).json({ error: "Missing store" });
    const slug = store.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

    let urls = [];
    if (PROVIDERS[provider]) urls = PROVIDERS[provider](slug);
    else if (provider === "ddg") {
      const now = new Date();
      urls = await ddg(`${store} ${product} coupon codes offers ${now.toLocaleString("en", { month: "long" })} ${now.getFullYear()} India`, 2);
    }
    const pages = (await Promise.all(urls.map(u => grab(u)))).filter(p => p && p.text.length > 600);
    if (!pages.length) return res.status(200).json({ coupons: [], sources: [], provider, store });

    const text = await gemini(key,
      `Extract ACTIVE coupon codes/deals for "${store}"${product ? ` (product: "${product}")` : ""} from these pages. Today is ${today}; skip expired.\n` +
      `Return ONLY a JSON array, max 8, best first: [{"code":"CODE or null","discount":"short headline","description":"1 sentence incl. conditions","expiry":"date or null","verified":true|false,"confidence":0-100,"source":1}] where source = SOURCE number.\n\n` +
      pages.map((p, i) => `SOURCE ${i + 1} — ${p.url}\n${p.text}`).join("\n---\n"));
    const coupons = pluck(text, "[", "]") || [];
    return res.status(200).json({ coupons, sources: pages.map(p => p.url), provider, store });
  } catch (e) {
    return res.status(200).json({ coupons: [], error: String(e.message || e), provider: q.provider, store: q.store });
  }
}
