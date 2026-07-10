// CouponHunter V3.1 — quota-efficient: ONE Gemini call per search
// Modes: ?mode=expand&q=...  |  ?store=..&product=..  (searches all providers, returns coupons+best)
// Env: GEMINI_API_KEY

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const MODELS = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-flash-latest"];

const PROVIDERS = {
  grabon: s => `https://www.grabon.in/${s}-coupons/`,
  desidime: s => `https://www.desidime.com/stores/${s}`,
  coupondunia: s => `https://www.coupondunia.in/${s}`,
  wethrift: s => `https://www.wethrift.com/${s}`,
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
    return { url, text: strip(await r.text()).slice(0, 10000) };
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

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function gemini(key, prompt) {
  let err = ""; const t0 = Date.now();
  for (const model of MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (Date.now() - t0 > 38000) throw new Error(err || "AI busy — try again shortly");
      const ctrl = new AbortController(); const tt = setTimeout(() => ctrl.abort(), 18000);
      try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.1, responseMimeType: "application/json" } }),
          signal: ctrl.signal,
        });
        if (r.status === 404) break; // model gone — next model
        const j = await r.json();
        if (j.error) {
          err = j.error.message || "err";
          if (/high demand|overloaded|503|try again/i.test(err) && attempt === 0) { await sleep(2500); continue; }
          break; // quota etc — next model
        }
        return (j.candidates?.[0]?.content?.parts || []).map(p => p.text).join("");
      } catch (e) { err = String(e.message || e); break; }
      finally { clearTimeout(tt); }
    }
  }
  throw new Error(err || "AI failed");
}

function pluck(text, open, close) {
  const a = text.indexOf(open), b = text.lastIndexOf(close);
  if (a === -1 || b <= a) return null;
  try { return JSON.parse(text.slice(a, b + 1)); } catch { return null; }
}

// ---- Non-AI fallback extractor: works even when Gemini is down/throttled ----
const NOTCODES = /^(COUPON|COUPONS|CODES?|COPY|OFFERS?|SALE|FLAT|UPTO|EXTRA|INDIA|VERIFIED|EXPIRED|DETAILS|SHOP|ONLINE|TODAY|DEALS?|STORES?|PRODUCTS?|SHIPPING|DELIVERY|LIMITED|GRABON|WETHRIFT|DESIDIME|COUPONDUNIA|SUBMIT|SIGNUP|LOGIN|TERMS|PRIVACY|ABOUT|CONTACT|SEARCH|CATEGORY|FASHION|BEAUTY|MOBILES?|APPAREL|FOOTWEAR|ELECTRONICS)$/;
function regexExtract(pages) {
  const out = [], seen = new Set();
  for (let pi = 0; pi < pages.length; pi++) {
    const t = pages[pi].text || "";
    const re = /\b[A-Z][A-Z0-9]{4,14}\b/g; let m;
    while ((m = re.exec(t)) && out.length < 12) {
      const code = m[0];
      if (seen.has(code) || NOTCODES.test(code)) continue;
      if (!/\d/.test(code)) continue; // real codes almost always contain digits — keeps precision high
      const ctx = t.slice(Math.max(0, m.index - 160), m.index + 160);
      if (!/coupon|code|copy|promo|voucher/i.test(ctx)) continue;
      const disc = (ctx.match(/(?:flat|upto|up to|extra|get)?\s*(?:₹\s?\d[\d,]*|rs\.?\s?\d[\d,]*|\d{1,2}%)\s*(?:off|discount|cashback)/i) || [])[0];
      seen.add(code);
      out.push({
        code, discount: disc ? disc.trim().replace(/\s+/g, " ") : "Deal code",
        description: `Spotted on ${pages[pi].prov} — apply at checkout to confirm the discount.`,
        expiry: null, verified: false, confidence: 40, bankOffer: null, source: pi + 1,
      });
    }
  }
  return out;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store"); // overwritten with s-maxage on success only
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: "GEMINI_API_KEY not set in Vercel." });
  const q = req.query || {};
  const today = new Date().toDateString();

  try {
    if (q.mode === "expand") {
      const text = await gemini(key,
        `User typed a shopping search (may be natural language like "I need an iPhone under ₹70,000" or "cheapest hosting"): "${String(q.q || "").slice(0, 160)}". Today is ${today}. Region: India.\n` +
        `Return ONLY JSON: {"product":"specific product name incl. budget constraint if given, or null if it's just a store","stores":["up to 2 lowercase store/brand slugs most relevant to buy this from in India"]}. If the query IS a store/brand, its slug must be first.`);
      return res.status(200).json(pluck(text, "{", "}") || { product: null, stores: [String(q.q || "").toLowerCase().replace(/[^a-z0-9]+/g, "-")] });
    }

    const store = String(q.store || "").trim().toLowerCase();
    const product = String(q.product || "").trim();
    if (!store) return res.status(400).json({ error: "Missing store" });
    const slug = store.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

    // Fetch ALL providers in parallel (no AI yet)
    const provNames = Object.keys(PROVIDERS);
    const fetched = await Promise.all(provNames.map(p => grab(PROVIDERS[p](slug))));
    let pages = [], status = {};
    fetched.forEach((pg, i) => {
      if (pg && pg.text.length > 600) { pages.push({ ...pg, prov: provNames[i] }); status[provNames[i]] = "ok"; }
      else status[provNames[i]] = "blocked";
    });
    if (pages.length < 2) {
      const now = new Date();
      const urls = await ddg(`${store} ${product} coupon codes offers ${now.toLocaleString("en", { month: "long" })} ${now.getFullYear()} India`, 2);
      const extra = await Promise.all(urls.map(u => grab(u)));
      extra.forEach(pg => { if (pg && pg.text.length > 600) { pages.push({ ...pg, prov: "web" }); status.web = "ok"; } });
      if (!status.web) status.web = "blocked";
    }
    pages = pages.slice(0, 5);
    if (!pages.length) return res.status(200).json({ coupons: [], sources: [], status, note: "All sources blocked our request. Try again in a minute." });

    // ONE combined AI call: full Savings Report (never empty). If AI fails, pattern-extraction still delivers.
    let text = "";
    try { text = await gemini(key,
      `You are an AI Shopping Savings engine. Mission: "never overpay again". Today is ${today}; skip expired offers. Region: India.\n` +
      `Store: "${store}"${product ? `, product: "${product}"` : ""}. Sources below.\n` +
      `Return ONLY JSON:\n` +
      `{"coupons":[max 10, best first: {"code":"CODE or null","discount":"short headline","description":"1 sentence incl. conditions","expiry":"date or null","verified":true|false,"confidence":0-100,"bankOffer":"bank/card offer text if mentioned, else null","source":<SOURCE number>}],\n` +
      `"best":{"headline":"the single smartest way to buy from ${store} today","code":"code or null","reason":"1 sentence why this beats the rest","confidence":0-100,"reasons":["2-4 short trust factors e.g. Verified recently / Confirmed by 2 sources / No expiry risk"],"breakdown":[{"label":"...","value":"..."} 2-4 rows from real source data only]},\n` +
      `"alternatives":[0-3 of {"store":"other store mentioned in sources with better/similar deals for this","why":"1 short sentence"}],\n` +
      `"otherWays":[ALWAYS 3-5 of {"title":"short","how":"1-2 sentences, concrete and actionable","type":"cashback|bank|newsletter|timing|membership|shipping|giftcard|other"}]}\n` +
      `Rules for otherWays: even if zero coupons found, give real non-coupon ways to pay less at ${store} (e.g. cashback portals like CashKaro, typical card offers at checkout, newsletter/first-order discounts, sale-season timing, gift card discounts, free-shipping thresholds). Base on sources when possible; general strategies allowed but NEVER invent specific amounts or codes.\n\n` +
      pages.map((p, i) => `SOURCE ${i + 1} [${p.prov}] — ${p.url}\n${p.text}`).join("\n---\n"));
    } catch (aiErr) { text = ""; } // AI down/throttled — regex fallback below takes over
    const out = pluck(text, "{", "}") || {};
    let coupons = (out.coupons || []).map(c => ({ ...c, provider: (pages[(c.source || 1) - 1] || {}).prov || "web", sourceUrl: (pages[(c.source || 1) - 1] || {}).url || "" }));
    if (!coupons.length) { // AI returned nothing usable — pattern-match the pages directly
      coupons = regexExtract(pages).map(c => ({ ...c, provider: (pages[(c.source || 1) - 1] || {}).prov || "web", sourceUrl: (pages[(c.source || 1) - 1] || {}).url || "" }));
    }
    if (coupons.length) res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=3600");
    return res.status(200).json({ coupons, best: out.best || null, alternatives: out.alternatives || [], otherWays: out.otherWays || [], sources: pages.map(p => ({ url: p.url, provider: p.prov })), status, store });
  } catch (e) {
    return res.status(200).json({ coupons: [], error: String(e.message || e), store: q.store });
  }
}
