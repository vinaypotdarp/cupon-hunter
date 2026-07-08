# Deal Hunter 🏷️

Free coupon & deal finder for Indian stores. Paste a product link (or type a store/product name) and it scrapes coupon sites + the web, then uses Google Gemini (free tier) to extract active codes.

## Deploy to Vercel (free)

1. Push this folder to a GitHub repo.
2. On https://vercel.com/new import the repo (framework preset: **Other**). No build command needed.
3. Get a free Gemini API key at https://aistudio.google.com/apikey (no credit card).
4. In Vercel → Project → **Settings → Environment Variables**, add:
   - `GEMINI_API_KEY` = your key
5. Deploy. Your app is live at `https://<project>.vercel.app`.

## Stack (all free)

- Static frontend (`index.html`)
- One Vercel serverless function (`api/find.js`):
  - Fetches GrabOn / DesiDime / CouponDunia pages directly, falls back to DuckDuckGo search (no API key)
  - Extracts codes with Gemini free tier (`GEMINI_API_KEY`)
