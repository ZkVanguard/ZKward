# SEO Runbook

What ships in the repo, and the two or three things you still need to do by hand.

## What's already wired

- **File-based icons** — `app/icon.tsx` (512×512 PNG) and `app/apple-icon.tsx` (180×180). Next serves them at `/icon` and `/apple-icon`. `<link rel="icon">` is injected automatically.
- **JSON-LD `Organization` + `WebSite`** — emitted on every page in `app/[locale]/layout.tsx`. Logo points to `/icon` (raster PNG, ≥ 512×512), so Google Search Console picks it up for the knowledge panel. `alternateName` covers old casings (ZkWard, ZkVanguard) so branded searches for legacy variants route back to the same entity.
- **JSON-LD `TechArticle`** on `/whitepaper` and `AboutPage` on `/story`.
- **Sitemap** at `/sitemap.xml` — every marketing route × 12 locales as hreflang siblings, with per-route priority and change frequency.
- **Robots** at `/robots.txt` — allows all crawlers, disallows `/api/`, `/dashboard`, `/paper`, `/_next/`, points to the sitemap.
- **Open Graph image** at `/opengraph-image` (1200×630 PNG generated at build time from `app/[locale]/opengraph-image.tsx`).
- **Twitter card** set to `summary_large_image` with `@HarveReg` as creator + site.
- **Web app manifest** at `/manifest.json` — categories: finance, productivity. Icons reference `/icon` (PNG) and `/favicon.svg`.
- **Contact point** on Organization schema: `ashish.regmi@zkward.com`.
- **Verification hooks** — reads `GOOGLE_SITE_VERIFICATION` and `BING_SITE_VERIFICATION` env vars and emits the corresponding `<meta>` tags.

## Manual steps

### 1. Google Search Console

1. Visit https://search.google.com/search-console and add `zkward.com` as a **Domain property** (not URL prefix — domain-level verifies all subdomains).
2. Choose **DNS verification**. Copy the TXT record Google gives you and add it to the domain's DNS.
3. Once verified, Google will show the property. Skip the meta-tag verification method entirely — DNS is cleaner and persists across deploys.
4. **Submit the sitemap.** In the property, Sitemaps → paste `https://zkward.com/sitemap.xml` → Submit.
5. **Request indexing** for the homepage and `/story` under URL Inspection. This nudges Google to crawl within hours instead of days.

If you want the `verification` meta tag approach instead of DNS:
- In Vercel prod env, set `GOOGLE_SITE_VERIFICATION` to the value Google gives you (just the token, not the full meta tag).
- Redeploy. The tag appears in `<head>` on every page.

### 2. Bing Webmaster Tools

1. Sign in at https://www.bing.com/webmasters with the same account you use for Google (Bing imports Google Search Console data automatically).
2. Add `zkward.com`.
3. Set `BING_SITE_VERIFICATION` in Vercel prod env, redeploy.
4. Submit sitemap URL: `https://zkward.com/sitemap.xml`.

### 3. Knowledge panel + brand entity

For "ZKward" to appear as a rich brand result in Google:
- **The Organization schema does the heavy lifting** — logo, name, alternateName, sameAs, founder, contactPoint all wired.
- **External signals matter.** Get the site linked from:
  - LinkedIn company page (create if you haven't)
  - Crunchbase or an equivalent startup directory
  - The SUI Foundation grants page (once T4-C closes)
  - Product Hunt (optional but bumps early brand recall)
- The knowledge panel typically appears **2 – 6 weeks after indexing + external signals**. Not instant.

### 4. Fixing a broken favicon in Search Console

If Search Console flags "logo not indexed":
- Confirm `curl -I https://zkward.com/icon` returns `Content-Type: image/png` and `200 OK`.
- Confirm the Organization schema's `logo.url` and `contentUrl` both point to `/icon`.
- Both are already true after PR #160. If Search Console still complains, request re-crawl via URL Inspection.

### 5. Local verification

Before shipping SEO changes, run:

```bash
# Sitemap valid?
curl -s https://<vercel-preview-url>/sitemap.xml | head -50

# Robots correct?
curl -s https://<vercel-preview-url>/robots.txt

# Structured data valid?
# Paste the fully-rendered page HTML into:
# https://validator.schema.org/
# Should show Organization + WebSite (+ TechArticle on /whitepaper, AboutPage on /story) with no errors.

# Rich results test:
# https://search.google.com/test/rich-results?url=https://<vercel-preview-url>
```

## Env vars

Set these in Vercel Production (and Preview if you want previews to verify too):

| Var | Where to get it |
|---|---|
| `GOOGLE_SITE_VERIFICATION` | Search Console → Settings → Ownership verification → HTML tag → copy just the `content` value |
| `BING_SITE_VERIFICATION` | Bing Webmaster → Add site → Meta tag method → copy just the `content` value |
| `NEXT_PUBLIC_BASE_URL` | Already set to `https://zkward.com` — required for absolute URLs in sitemap and JSON-LD |

## What breaks SEO if you touch it wrong

- **Do not** replace the `/icon` route with an SVG. Search Console's knowledge-panel logo carousel skips SVG.
- **Do not** disallow `/story` or `/whitepaper` in `robots.ts` — those are the primary brand pages after the home page.
- **Do not** set `canonical` on locale pages to point at the default-locale URL. Each locale is a distinct canonical; hreflang stitches them together as siblings.
- **Do not** ship `noindex` on any marketing page. Even if content is thin, Google is more forgiving to indexed-but-quiet than to noindexed-and-hidden.
