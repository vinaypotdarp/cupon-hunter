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
function titleCase(s) {
  return s.replace(/\s+/g, " ").trim().replace(/\b([a-z])/g, (_, c) => c.toUpperCase())
    .replace(/\bRs\.?\s?(\d)/gi, "₹$1").replace(/\bUpto\b/g, "Up to");
}
function findDiscount(ctx) {
  const pats = [
    /(?:flat|extra|upto|up to|save|get)\s*(?:₹\s?|rs\.?\s?)?\d[\d,]*\s?%?\s*(?:off|discount|cashback)/i,
    /(?:₹\s?|rs\.?\s?)\d[\d,]*\s*(?:off|discount|cashback)/i,
    /\d{1,2}\s?%\s*(?:off|discount|cashback)/i,
    /buy\s?\d+\s?,?\s?get\s?\d+[^.,|]{0,20}/i,
    /free\s(?:delivery|shipping|gift)[^.,|]{0,15}/i,
  ];
  for (const p of pats) { const m = ctx.match(p); if (m) return titleCase(m[0]); }
  return null;
}
function findDescription(ctx, code) {
  // Kill leftover markup/class junk tokens (e.g. *]:!w-full, mt-2">) before matching
  const clean = ctx.replace(/\S*[\[\]{}<>="\\!]\S*/g, " ").replace(/\s+/g, " ");
  const re = /(?:flat|extra|upto|up to|save|get|buy|avail|enjoy|grab)\s[^|•·]{10,110}?(?:off|discount|cashback|delivery|shipping|order|purchase|sitewide|gift)(?:s?\s?(?:above|over|of)?\s?(?:₹\s?|rs\.?\s?)?\d[\d,]*)?[a-z ]{0,20}/gi;
  let m;
  while ((m = re.exec(clean))) {
    let d = m[0].replace(/\s+/g, " ").trim();
    if (/get coupon|verified \d|used \d|last verified|show code|reveal/i.test(d)) continue; // nav/badge junk
    // strip nav-text leaks and dangling prepositions
    d = d.replace(/\b(?:more informat\w*|show details?|view details?|see details?|t&cs?|terms apply)\b/gi, " ")
      .replace(/\s+/g, " ").trim()
      .replace(/[,\s]*(?:above|over|on orders?|on|of|for|upto|up to)$/i, "").trim();
    if (d.length < 12) continue;
    d = d.charAt(0).toUpperCase() + d.slice(1);
    if (!/[.!]$/.test(d)) d += ".";
    return d;
  }
  return null;
}
function findExpiry(ctx) {
  const m = ctx.match(/(?:valid (?:till|until|upto)|expires?(?: on)?|ends?(?: on)?)\s*[:\-]?\s*(\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]{3,9}\.?,?\s*\d{0,4}|[A-Za-z]{3,9}\s+\d{1,2},?\s*\d{0,4}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i);
  return m ? m[1].trim() : null;
}
function regexExtract(pages) {
  const out = [], seen = new Set();
  for (let pi = 0; pi < pages.length; pi++) {
    const t = pages[pi].text || "";
    const re = /\b[A-Z][A-Z0-9]{4,14}\b/g; let m;
    while ((m = re.exec(t)) && out.length < 12) {
      const code = m[0];
      if (seen.has(code) || NOTCODES.test(code)) continue;
      if (!/\d/.test(code)) continue; // real codes almost always contain digits — keeps precision high
      const ctx = t.slice(Math.max(0, m.index - 240), m.index + 200);
      if (!/coupon|code|copy|promo|voucher/i.test(ctx)) continue;
      const disc = findDiscount(ctx);
      const desc = findDescription(ctx, code);
      const expiry = findExpiry(ctx);
      seen.add(code);
      out.push({
        code,
        discount: disc || "Deal Code",
        description: desc || `Found on ${pages[pi].prov} — apply at checkout to confirm the discount.`,
        expiry, verified: false,
        confidence: disc && desc ? 62 : disc ? 55 : 42,
        bankOffer: null, source: pi + 1,
      });
    }
  }
  // Best-detailed codes first
  return out.sort((a, b) => b.confidence - a.confidence);
}
// Estimated saving value for ranking: ₹ amounts as-is, percentages ×15, cashback halved
function dealValue(c) {
  const s = `${c.discount || ""} ${c.description || ""}`;
  let v = 0;
  const rup = s.match(/(?:₹\s?|rs\.?\s?)(\d[\d,]*)/i);
  if (rup) v = parseInt(rup[1].replace(/,/g, ""), 10) || 0;
  const pct = s.match(/(\d{1,2})\s?%/);
  if (pct) v = Math.max(v, (parseInt(pct[1], 10) || 0) * 15);
  if (/cashback/i.test(s)) v *= 0.5;
  return v;
}
// Code-less deals (Flipkart etc. mostly run deals + bank offers, not codes)
function dealExtract(pages, existing) {
  const out = [], seen = new Set(existing.map(c => (c.discount || "").toLowerCase()));
  for (let pi = 0; pi < pages.length; pi++) {
    const t = (pages[pi].text || "").replace(/\S*[\[\]{}<>="\\!]\S*/g, " ").replace(/\s+/g, " ");
    const re = /(?:flat|upto|up to|extra|get)\s?(?:₹\s?|rs\.?\s?)?\d[\d,]*\s?%?\s*(?:off|cashback|discount)(?:\s(?:on|across|above|over|for|sitewide)\s[^.|,;:]{3,50})?/gi;
    let m;
    while ((m = re.exec(t)) && out.length < 8) {
      let d = m[0].replace(/\s+/g, " ").trim();
      if (/more informat|show |view |details/i.test(d)) d = d.split(/more informat|show |view |details/i)[0].trim();
      const key = d.toLowerCase().replace(/[^a-z0-9%₹]/g, "");
      if (d.length < 10 || seen.has(key)) continue;
      seen.add(key);
      out.push({
        code: null, discount: titleCase(d),
        description: `Live deal listed on ${pages[pi].prov} — no code needed, discount applies on the store.`,
        expiry: null, verified: false, confidence: 45, bankOffer: null, source: pi + 1,
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
    let best = out.best || null, otherWays = out.otherWays || [];
    if (!coupons.length) { // AI returned nothing usable — pattern-match the pages directly
      let extracted = regexExtract(pages);
      if (extracted.length < 4) extracted = extracted.concat(dealExtract(pages, extracted)).slice(0, 10);
      extracted.sort((a, b) => (dealValue(b) - dealValue(a)) || (b.confidence - a.confidence) || ((b.code ? 1 : 0) - (a.code ? 1 : 0)));
      coupons = extracted.map(c => ({ ...c, provider: (pages[(c.source || 1) - 1] || {}).prov || "web", sourceUrl: (pages[(c.source || 1) - 1] || {}).url || "" }));
      if (coupons.length && !best) {
        const top = coupons[0];
        best = {
          headline: top.code ? (top.discount !== "Deal Code" ? `${top.discount} with code ${top.code}` : `Try code ${top.code} at checkout`) : `${top.discount} — live deal, no code needed`,
          code: top.code, confidence: top.confidence,
          reason: `Best-detailed offer found across ${pages.length} live coupon sources right now.`,
          reasons: [`Seen on ${top.provider}`, `${coupons.length} offer${coupons.length > 1 ? "s" : ""} found on ${new Set(coupons.map(c => c.provider)).size} live source${new Set(coupons.map(c => c.provider)).size > 1 ? "s" : ""}`, "Confirm the discount at checkout"],
          breakdown: coupons.slice(0, 3).map(c => ({ label: c.code || "Deal", value: c.discount })),
        };
      }
      if (!otherWays.length) otherWays = [
        { title: "Cashback portals", how: `Activate ${store} via CashKaro or GoPaisa before buying — cashback stacks on top of coupon codes.`, type: "cashback" },
        { title: "Card offers at checkout", how: "Check the payment page for instant bank discounts (HDFC/ICICI/SBI cards often get 5-10% off).", type: "bank" },
        { title: "First-order / newsletter discount", how: `Sign up on ${store} with a new email — most stores send a welcome code within minutes.`, type: "newsletter" },
        { title: "Time it to a sale", how: "Prices drop hardest during payday-end sales and festival events — add to cart and watch for 2-3 days if you can wait.", type: "timing" },
      ];
    }
    if (coupons.length) res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=3600");
    return res.status(200).json({ coupons, best, alternatives: out.alternatives || [], otherWays, sources: pages.map(p => ({ url: p.url, provider: p.prov })), status, store });
  } catch (e) {
    return res.status(200).json({ coupons: [], error: String(e.message || e), store: q.store });
  }
}
