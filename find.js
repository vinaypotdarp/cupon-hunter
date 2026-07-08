// Deal Hunter — Vercel serverless function
// Free stack: scrapes public coupon pages + DuckDuckGo, extracts codes with Google Gemini (free API key).
// Env var required: GEMINI_API_KEY  (get one free at https://aistudio.google.com/apikey)

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const GEMINI_MODELS = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-flash"];

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#\d+;/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

async function fetchText(url, ms = 9000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-IN,en;q=0.9",
      },
      redirect: "follow",
      signal: ctrl.signal,
    });
    if (!r.ok) return null;
    const html = await r.text();
    return { url, text: stripHtml(html).slice(0, 13000) };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// DuckDuckGo HTML search (no API key). Returns up to n result URLs.
async function ddgSearch(query, n = 3) {
  const res = await fetchText(
    "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query),
    8000
  );
  const urls = [];
  if (!res) return urls;
  // fetchText stripped tags, so re-fetch raw for links — cheaper: parse from a raw fetch here instead.
  try {
    const r = await fetch(
      "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query),
      { headers: { "User-Agent": UA } }
    );
    const html = await r.text();
    const re = /uddg=([^&"]+)/g;
    let m;
    while ((m = re.exec(html)) && urls.length < n) {
      try {
        const u = decodeURIComponent(m[1]);
        if (u.startsWith("http") && !urls.includes(u)) urls.push(u);
      } catch {}
    }
  } catch {}
  return urls;
}

async function geminiExtract(apiKey, store, product, docs) {
  const today = new Date().toDateString();
  const prompt =
    `You are a coupon extraction engine. From the scraped coupon/deal pages below, extract ACTIVE coupon codes and deals for the store "${store}"` +
    (product ? ` and/or the product "${product}"` : "") +
    `. Today is ${today} — ignore anything clearly expired.\n` +
    `Respond with ONLY a JSON array, max 12 entries, best discounts first, deduplicated. Each entry:\n` +
    `{"code": "CODE or null for no-code deals", "discount": "short headline e.g. Flat ₹500 OFF", "description": "1 sentence: what it applies to + conditions", "expiry": "date or null", "verified": true|false, "source": <1-based index of the SOURCE it came from>}\n` +
    `If nothing usable, return [].\n\n` +
    docs.map((d, i) => `SOURCE ${i + 1} — ${d.url}\n${d.text}`).join("\n\n---\n\n");

  let lastErr = "";
  for (const model of GEMINI_MODELS) {
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.1, responseMimeType: "application/json" },
          }),
        }
      );
      if (r.status === 404) continue; // model not available, try next
      const j = await r.json();
      if (j.error) {
        lastErr = j.error.message || "Gemini error";
        if (/quota|rate/i.test(lastErr)) break;
        continue;
      }
      const text =
        j.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
      const a = text.indexOf("[");
      const b = text.lastIndexOf("]");
      if (a !== -1 && b > a) return { coupons: JSON.parse(text.slice(a, b + 1)) };
    } catch (e) {
      lastErr = String(e.message || e);
    }
  }
  return { coupons: null, error: lastErr || "AI extraction failed" };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const store = String(req.query.store || "").trim().toLowerCase();
  const product = String(req.query.product || "").trim();
  if (!store) return res.status(400).json({ error: "Missing ?store=" });
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey)
    return res.status(500).json({
      error:
        "GEMINI_API_KEY is not set. Add it in Vercel → Project → Settings → Environment Variables (free key: aistudio.google.com/apikey).",
    });

  const slug = store.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  // 1) Known coupon aggregator pages (direct, fast)
  const direct = [
    `https://www.grabon.in/${slug}-coupons/`,
    `https://www.desidime.com/stores/${slug}`,
    `https://www.coupondunia.in/${slug}`,
  ];

  let pages = (await Promise.all(direct.map((u) => fetchText(u)))).filter(
    (p) => p && p.text.length > 800
  );

  // 2) Fallback: DuckDuckGo search for coupon pages
  if (pages.length < 2) {
    const now = new Date();
    const q = `${store} coupon codes offers ${now.toLocaleString("en", { month: "long" })} ${now.getFullYear()} India`;
    const urls = await ddgSearch(q, 3);
    const extra = (await Promise.all(urls.map((u) => fetchText(u)))).filter(
      (p) => p && p.text.length > 800
    );
    pages = pages.concat(extra);
  }

  // Product-specific deals (one extra search)
  if (product && pages.length < 4) {
    const urls = await ddgSearch(`"${product}" price deal offer discount India`, 2);
    const extra = (await Promise.all(urls.map((u) => fetchText(u)))).filter(
      (p) => p && p.text.length > 800
    );
    pages = pages.concat(extra);
  }

  pages = pages.slice(0, 4);
  if (pages.length === 0)
    return res.status(200).json({
      coupons: [],
      sources: [],
      note: "Couldn't fetch any coupon pages (sites may be blocking server requests). Use the quick links.",
    });

  const ai = await geminiExtract(apiKey, store, product, pages);
  if (!ai.coupons)
    return res.status(200).json({
      coupons: [],
      sources: pages.map((p) => p.url),
      note: "AI extraction failed: " + ai.error,
    });

  return res.status(200).json({
    coupons: ai.coupons,
    sources: pages.map((p) => p.url),
  });
}
