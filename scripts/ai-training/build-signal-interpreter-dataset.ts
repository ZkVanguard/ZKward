/**
 * Signal-interpreter dataset extractor.
 *
 * Pulls prediction-market titles from four sources, dedupes by slug, and
 * writes `data/signal-interpreter/raw.jsonl` — one JSON object per line:
 *
 *   { source, slug, title, endDate?, liquidity?, volume24hr?, url? }
 *
 * Sources:
 *   1. cron_state:poly-discover:topByRelevance — recent Polymarket broad
 *      markets (full title text, liquidity, volume)
 *   2. cron_state:poly-discover:seenBroadSlugs — 2000-entry dedup ring
 *      (slugs only — we fetch full titles from Polymarket Gamma API)
 *   3. Manifold live: /v0/search-markets?term=crypto (paginated)
 *   4. Delphi cache: whatever DelphiMarketService has queried recently
 *
 * Run:
 *   bun run scripts/ai-training/build-signal-interpreter-dataset.ts \
 *     [--limit=2000] [--out=data/signal-interpreter/raw.jsonl]
 *
 * No writes to production state. Fetches over HTTP; rate-limits itself.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getPool } from '../../lib/db/postgres';

const DEFAULT_OUT = 'data/signal-interpreter/raw.jsonl';
const DEFAULT_LIMIT = 2000;
const POLYMARKET_BATCH = 100;      // Gamma API page size
const POLYMARKET_SLEEP_MS = 300;   // between paginated calls (be polite)
const MANIFOLD_MAX_PAGES = 10;
const REQUEST_TIMEOUT_MS = 15_000;

interface RawExample {
  source: 'polymarket' | 'manifold' | 'delphi';
  slug: string;
  title: string;
  question?: string;
  endDate?: string;
  liquidity?: number;
  volume24hr?: number;
  url?: string;
  category?: string;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out: Record<string, string> = {};
  for (const a of args) {
    const m = a.match(/^--([a-z\-]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] ?? 'true';
  }
  return {
    limit: Number(out.limit ?? DEFAULT_LIMIT),
    outPath: (out.out ?? DEFAULT_OUT).trim(),
  };
}

async function fetchWithTimeout(url: string, ms = REQUEST_TIMEOUT_MS): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function pullPolymarketTop(): Promise<RawExample[]> {
  const pool = getPool();
  const r = await pool.query(
    `SELECT value FROM cron_state WHERE key = 'poly-discover:topByRelevance'`,
  );
  const raw = r.rows[0]?.value;
  const ranked: any[] = Array.isArray(raw?.ranked) ? raw.ranked : [];
  return ranked
    .filter((x) => x?.slug && x?.question)
    .map((x) => ({
      source: 'polymarket' as const,
      slug: String(x.slug),
      title: String(x.question),
      question: String(x.question),
      liquidity: Number(x.liquidity ?? 0),
      volume24hr: Number(x.volume24hr ?? 0),
      category: String(x.marketType ?? 'unknown'),
      url: `https://polymarket.com/event/${x.slug}`,
    }));
}

async function pullPolymarketFromGamma(limit: number): Promise<RawExample[]> {
  // Public paginated market list; filter to crypto/finance-adjacent tags
  // and drop resolved markets.
  const out: RawExample[] = [];
  let offset = 0;
  while (out.length < limit) {
    const url =
      `https://gamma-api.polymarket.com/markets` +
      `?limit=${POLYMARKET_BATCH}&offset=${offset}&closed=false&active=true`;
    let resp: Response;
    try {
      resp = await fetchWithTimeout(url);
    } catch (e) {
      console.error(`[polymarket] fetch failed at offset=${offset}:`, e);
      break;
    }
    if (!resp.ok) {
      console.error(`[polymarket] HTTP ${resp.status} at offset=${offset}`);
      break;
    }
    const rows = (await resp.json()) as any[];
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const m of rows) {
      const title = m?.question ?? m?.title;
      const slug = m?.slug ?? m?.marketMakerAddress ?? '';
      if (!title || !slug) continue;
      out.push({
        source: 'polymarket',
        slug: String(slug),
        title: String(title),
        question: String(title),
        endDate: m?.endDate ? String(m.endDate) : undefined,
        liquidity: Number(m?.liquidity ?? m?.liquidityNum ?? 0),
        volume24hr: Number(m?.volume24hr ?? m?.volume ?? 0),
        category: String(m?.category ?? 'unknown'),
        url: `https://polymarket.com/event/${slug}`,
      });
      if (out.length >= limit) break;
    }
    offset += POLYMARKET_BATCH;
    await sleep(POLYMARKET_SLEEP_MS);
  }
  return out;
}

async function pullManifoldCrypto(): Promise<RawExample[]> {
  const out: RawExample[] = [];
  const terms = ['bitcoin', 'ethereum', 'crypto', 'BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'perp'];
  for (const term of terms) {
    for (let page = 0; page < MANIFOLD_MAX_PAGES; page++) {
      const url = `https://api.manifold.markets/v0/search-markets?term=${encodeURIComponent(term)}&limit=100&offset=${page * 100}`;
      try {
        const resp = await fetchWithTimeout(url);
        if (!resp.ok) break;
        const rows = (await resp.json()) as any[];
        if (!Array.isArray(rows) || rows.length === 0) break;
        for (const m of rows) {
          if (!m?.question || !m?.slug) continue;
          if (m.isResolved) continue;
          out.push({
            source: 'manifold',
            slug: String(m.slug),
            title: String(m.question),
            question: String(m.question),
            endDate: m?.closeTime ? new Date(m.closeTime).toISOString() : undefined,
            liquidity: Number(m?.totalLiquidity ?? 0),
            volume24hr: Number(m?.volume24Hours ?? 0),
            url: `https://manifold.markets/${m?.creatorUsername ?? '_'}/${m.slug}`,
          });
        }
      } catch (e) {
        console.error(`[manifold] fetch failed for "${term}" page ${page}:`, e);
        break;
      }
      await sleep(200);
    }
  }
  return out;
}

function dedupe(examples: RawExample[]): RawExample[] {
  const seen = new Set<string>();
  const out: RawExample[] = [];
  for (const e of examples) {
    const key = `${e.source}:${e.slug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

async function main() {
  const { limit, outPath } = parseArgs();
  console.log(`Target: ${limit} examples → ${outPath}`);

  const parts: RawExample[] = [];

  console.log('[1/3] Polymarket topByRelevance from cron_state...');
  try {
    const top = await pullPolymarketTop();
    console.log(`  → ${top.length} examples`);
    parts.push(...top);
  } catch (e) {
    console.error('  failed:', e);
  }

  console.log('[2/3] Polymarket Gamma API (active + non-resolved)...');
  try {
    const gamma = await pullPolymarketFromGamma(Math.max(0, limit - parts.length));
    console.log(`  → ${gamma.length} examples`);
    parts.push(...gamma);
  } catch (e) {
    console.error('  failed:', e);
  }

  if (parts.length < limit) {
    console.log('[3/3] Manifold crypto markets...');
    try {
      const mnf = await pullManifoldCrypto();
      console.log(`  → ${mnf.length} examples`);
      parts.push(...mnf);
    } catch (e) {
      console.error('  failed:', e);
    }
  } else {
    console.log('[3/3] skipping Manifold — already at limit');
  }

  const deduped = dedupe(parts).slice(0, limit);
  console.log(`\nDeduped: ${parts.length} → ${deduped.length} examples`);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const lines = deduped.map((e) => JSON.stringify(e)).join('\n');
  fs.writeFileSync(outPath, lines + '\n', 'utf8');
  console.log(`\nWrote ${deduped.length} lines to ${outPath}`);
  console.log('\nBreakdown by source:');
  const bySource: Record<string, number> = {};
  for (const e of deduped) bySource[e.source] = (bySource[e.source] ?? 0) + 1;
  for (const [s, n] of Object.entries(bySource)) {
    console.log(`  ${s.padEnd(12)} ${n}`);
  }

  await getPool().end();
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
