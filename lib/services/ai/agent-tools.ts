/**
 * Agent tool registry — read-only capabilities the Layer 3 specialized
 * agents (HedgingAgent, RiskAgent, ReportingAgent, SettlementAgent,
 * SuiPoolAgent) can call from within a tool-use LLM loop.
 *
 * ## Why in-process (not MCP protocol)
 *
 * Real Anthropic MCP is a client-side protocol (stdio/HTTP transports).
 * At Vercel runtime we already have direct import access to every data
 * source MCP would proxy — Aiven Postgres, unified-price-provider,
 * cron_state, signal_interpretations. Wrapping in-process functions
 * in the OpenAI tool-use format gives us the same reasoning capability
 * without a broker.
 *
 * ## Read-only invariant
 *
 * These tools NEVER mutate state. No trade opens, no cron writes, no
 * DB inserts. If an agent needs to act, it produces a recommendation
 * and the caller decides — the tool boundary is the safety boundary.
 */

import { logger } from '@/lib/utils/logger';
import { HEDGES_REAL_ONLY_SQL } from '@/lib/db/hedges-scope';

/** OpenAI-tool-use compatible schema. */
export interface AgentTool<TArgs = Record<string, unknown>, TResult = unknown> {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  execute: (args: TArgs) => Promise<TResult>;
}

// ── Tools ─────────────────────────────────────────────────────────────

const queryRecentInterpretations: AgentTool<
  { asset?: string; hours?: number; limit?: number },
  Array<{
    slug: string;
    title: string;
    asset: string | null;
    direction: string;
    confidence: number;
    novelty: number | null;
    interpreted_at: string;
    outcome_correct: boolean | null;
  }>
> = {
  name: 'query_recent_interpretations',
  description:
    'Fetch recent Signal Interpreter outputs from postgres. Use to see what the AI has been parsing lately, what novelty scores it flagged, and which calls were validated by realized market moves.',
  parameters: {
    type: 'object',
    properties: {
      asset: { type: 'string', description: 'Optional asset filter, e.g. "BTC"' },
      hours: { type: 'number', description: 'Lookback window in hours. Default 24.' },
      limit: { type: 'number', description: 'Row cap. Default 50, max 200.' },
    },
    additionalProperties: false,
  },
  async execute({ asset, hours = 24, limit = 50 }) {
    const { query } = await import('@/lib/db/postgres');
    const cap = Math.min(Math.max(1, limit), 200);
    const sinceMs = Date.now() - hours * 60 * 60 * 1000;
    const params: unknown[] = [new Date(sinceMs).toISOString()];
    let where = 'interpreted_at >= $1';
    if (asset) {
      params.push(asset.toUpperCase());
      where += ` AND asset = $${params.length}`;
    }
    params.push(cap);
    return await query(
      `SELECT slug, title, asset, direction, confidence, novelty, interpreted_at, outcome_correct
       FROM signal_interpretations
       WHERE ${where}
       ORDER BY interpreted_at DESC
       LIMIT $${params.length}`,
      params,
    );
  },
};

const queryHedgeHistory: AgentTool<
  { asset?: string; hours?: number; status?: 'active' | 'closed'; limit?: number },
  Array<{
    order_id: string;
    asset: string;
    side: string;
    notional_value: number;
    status: string;
    realized_pnl: number;
    current_pnl: number;
    created_at: string;
    closed_at: string | null;
  }>
> = {
  name: 'query_hedge_history',
  description:
    'Fetch recent hedges (open + closed positions on BlueFin). Use to reason about recent P&L, win rate, or specific asset exposure.',
  parameters: {
    type: 'object',
    properties: {
      asset: { type: 'string', description: 'Optional asset filter' },
      hours: { type: 'number', description: 'Lookback in hours. Default 168 (7d).' },
      status: { type: 'string', enum: ['active', 'closed'], description: 'Filter by status' },
      limit: { type: 'number', description: 'Row cap. Default 50, max 200.' },
    },
    additionalProperties: false,
  },
  async execute({ asset, hours = 168, status, limit = 50 }) {
    const { query } = await import('@/lib/db/postgres');
    const cap = Math.min(Math.max(1, limit), 200);
    const sinceMs = Date.now() - hours * 60 * 60 * 1000;
    const params: unknown[] = [new Date(sinceMs).toISOString()];
    // HEDGES_REAL_ONLY_SQL — the LLM reasoning tool answers questions
    // about the live trader; paper trades in the same table would poison
    // its judgment (138 paper trades vs 174 real in 30d; 2026-09-18).
    let where = `created_at >= $1 AND ${HEDGES_REAL_ONLY_SQL}`;
    if (asset) {
      params.push(asset.toUpperCase());
      where += ` AND asset = $${params.length}`;
    }
    if (status) {
      params.push(status);
      where += ` AND status = $${params.length}`;
    }
    params.push(cap);
    return await query(
      `SELECT order_id, asset, side, notional_value, status, realized_pnl, current_pnl, created_at, closed_at
       FROM hedges
       WHERE ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length}`,
      params,
    );
  },
};

const getAssetPrice: AgentTool<
  { asset: string },
  { asset: string; price: number; confidence: string; sources: number }
> = {
  name: 'get_asset_price',
  description:
    'Fetch validated spot price for an asset across multiple sources. Returns median with confidence and source count.',
  parameters: {
    type: 'object',
    properties: {
      asset: { type: 'string', description: 'Asset ticker: BTC, ETH, SOL, SUI, etc.' },
    },
    required: ['asset'],
    additionalProperties: false,
  },
  async execute({ asset }) {
    const { getMultiSourceValidatedPrice } = await import(
      '@/lib/services/market-data/unified-price-provider'
    );
    const v = await getMultiSourceValidatedPrice(asset.toUpperCase());
    return { asset: asset.toUpperCase(), price: v.price, confidence: v.confidence, sources: v.sources.length };
  },
};

const getCronStateSnapshot: AgentTool<
  { key: string },
  { key: string; value: unknown; exists: boolean }
> = {
  name: 'get_cron_state',
  description:
    'Read one key from the cron_state table. Use for halts, peaks, ring buffers, or any state written by cron routes. Keys are namespaced strings like "cron:lastRun:sui-community-pool" or "alert-log:ring-buffer".',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Exact cron_state key' },
    },
    required: ['key'],
    additionalProperties: false,
  },
  async execute({ key }) {
    const { getCronState } = await import('@/lib/db/cron-state');
    const value = await getCronState(key);
    return { key, value, exists: value !== null && value !== undefined };
  },
};

const queryPostmortemStats: AgentTool<
  { days?: number },
  { total: number; resolved: number; correct: number; wrong: number; accuracy: number }
> = {
  name: 'query_postmortem_stats',
  description:
    'Aggregate signal-interpretation outcomes over the last N days. Returns hit rate — this is the "how well is the AI actually predicting?" answer.',
  parameters: {
    type: 'object',
    properties: {
      days: { type: 'number', description: 'Lookback window. Default 30.' },
    },
    additionalProperties: false,
  },
  async execute({ days = 30 }) {
    // 5-min per-lookback cache: this is a 30-day aggregate that shifts
    // slowly, and the AI chat calls this on almost every relevant
    // question. Uncached hits are the single biggest chat-latency spike
    // when the Cloudflare-tunneled DB flaps (verified 2026-09-21: 3s+
    // per call). Cache key includes `days` so different lookbacks don't
    // step on each other.
    const cacheKey = `pm-${days}`;
    const cached = _postmortemCache.get(cacheKey);
    if (cached && Date.now() - cached.at < POSTMORTEM_CACHE_TTL_MS) {
      return cached.value;
    }
    const { query } = await import('@/lib/db/postgres');
    const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
    const rows = await query<{ outcome_correct: boolean | null }>(
      `SELECT outcome_correct FROM signal_interpretations
       WHERE outcome_linked_at IS NOT NULL AND outcome_linked_at >= $1`,
      [new Date(sinceMs).toISOString()],
    );
    const total = rows.length;
    const resolved = rows.filter((r) => r.outcome_correct !== null).length;
    const correct = rows.filter((r) => r.outcome_correct === true).length;
    const wrong = rows.filter((r) => r.outcome_correct === false).length;
    const value = {
      total,
      resolved,
      correct,
      wrong,
      accuracy: resolved > 0 ? correct / resolved : 0,
    };
    _postmortemCache.set(cacheKey, { at: Date.now(), value });
    return value;
  },
};

// Serverless-scoped cache. Dies with the lambda, which is fine — first
// request after cold-start pays the DB hit, subsequent requests within
// TTL are instant.
const POSTMORTEM_CACHE_TTL_MS = 5 * 60 * 1000;
const _postmortemCache = new Map<
  string,
  { at: number; value: { total: number; resolved: number; correct: number; wrong: number; accuracy: number } }
>();

const getTreasuryStateTool: AgentTool<
  Record<string, never>,
  {
    totalPnlUsd: number;
    totalOpsUsd: number;
    totalReinvestUsd: number;
    freeBalanceUsd: number;
    healthy: boolean;
    entries: number;
  }
> = {
  name: 'get_treasury_state',
  description:
    'Read the agent-treasury snapshot: cumulative realized P&L, operational costs, reinvestment spend, free balance, and health flag. Use before proposing any spend — reinvestment must be affordable relative to free balance.',
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  async execute() {
    const { getTreasuryState } = await import('@/lib/db/treasury');
    const s = await getTreasuryState();
    return {
      totalPnlUsd: s.totalPnlUsd,
      totalOpsUsd: s.totalOpsUsd,
      totalReinvestUsd: s.totalReinvestUsd,
      freeBalanceUsd: s.freeBalanceUsd,
      healthy: s.healthy,
      entries: s.entries,
    };
  },
};

const getMarketSnapshot: AgentTool<
  { assets?: string[] },
  Record<string, { price: number; confidence: string; sources: number } | { error: string }>
> = {
  name: 'get_market_snapshot',
  description:
    'Get validated spot prices for multiple crypto assets in one call. Use for "how is the market today?"-style questions. Defaults to BTC + ETH + SOL + SUI when no assets specified.',
  parameters: {
    type: 'object',
    properties: {
      assets: {
        type: 'array',
        items: { type: 'string' },
        description: 'Tickers to snapshot (max 8). Default: BTC, ETH, SOL, SUI.',
      },
    },
    additionalProperties: false,
  },
  async execute({ assets }) {
    const { getMultiSourceValidatedPrice } = await import(
      '@/lib/services/market-data/unified-price-provider'
    );
    const list = (assets && assets.length ? assets : ['BTC', 'ETH', 'SOL', 'SUI'])
      .slice(0, 8)
      .map((a) => a.toUpperCase());
    const entries = await Promise.all(
      list.map(async (a) => {
        try {
          const v = await getMultiSourceValidatedPrice(a);
          return [a, { price: v.price, confidence: v.confidence, sources: v.sources.length }] as const;
        } catch (e) {
          return [a, { error: e instanceof Error ? e.message : 'lookup failed' }] as const;
        }
      }),
    );
    return Object.fromEntries(entries);
  },
};

const getPredictionSignal: AgentTool<
  { asset?: string; assets?: string[] },
  Record<
    string,
    {
      direction: 'UP' | 'DOWN' | 'NEUTRAL';
      confidence: number;
      probability: number;
      consensus: number;
      recommendation: string;
      reasoning: string;
    }
  >
> = {
  name: 'get_prediction_signal',
  description:
    'Get the fused prediction-market signal for one or more crypto assets — direction (UP/DOWN/NEUTRAL), confidence 0-100, consensus across sources, and the current trader recommendation. This is what the trading agents actually see. Use for "what does the market think about X?" or "should we be long/short?" questions.',
  parameters: {
    type: 'object',
    properties: {
      asset: { type: 'string', description: 'Single asset ticker, e.g. "BTC". Ignored if `assets` is given.' },
      assets: {
        type: 'array',
        items: { type: 'string' },
        description: 'Multiple tickers. Max 6. Defaults to BTC + ETH if neither given.',
      },
    },
    additionalProperties: false,
  },
  async execute({ asset, assets }) {
    const { PredictionAggregatorService } = await import(
      '@/lib/services/market-data/PredictionAggregatorService'
    );
    const list = (assets && assets.length ? assets : asset ? [asset] : ['BTC', 'ETH'])
      .slice(0, 6)
      .map((a) => a.toUpperCase());
    const raw = await PredictionAggregatorService.getPerAssetPredictions(list);
    const out: Record<string, ReturnType<typeof shape>> = {};
    function shape(p: (typeof raw)[string]) {
      return {
        direction: p.direction,
        confidence: Math.round(p.confidence),
        probability: Math.round(p.probability),
        consensus: Math.round(p.consensus),
        recommendation: p.recommendation,
        reasoning: p.reasoning,
      };
    }
    for (const a of list) if (raw[a]) out[a] = shape(raw[a]);
    return out;
  },
};

/**
 * Broader market data — hits Crypto.com's public tickers endpoint which lists
 * ~200 crypto pairs. This is the "AI shouldn't be limited to our 5 tracked
 * assets" tool. Returns price + 24h change + 24h volume for any listed
 * ticker. When asked about a specific asset outside the trader universe
 * (e.g., ADA, LINK, AVAX, MATIC, DOT), the agent uses this instead of
 * failing on the tracked-only get_asset_price path.
 *
 * Cached 30s to bound Crypto.com API load across concurrent chat sessions.
 */
const getBroaderMarket: AgentTool<
  { symbol?: string; topN?: number },
  {
    top?: Array<{ symbol: string; price: number; change24hPct: number; volume24hUsd: number }>;
    symbol?: { symbol: string; price: number; change24hPct: number; volume24hUsd: number } | { error: string };
  }
> = {
  name: 'get_broader_market',
  description:
    'Look up ANY crypto asset beyond the trader universe — price + 24h change + volume via Crypto.com public tickers (~200 pairs listed). Use this for ADA, LINK, AVAX, MATIC, DOT, or any other asset the user asks about that\'s not one of BTC/ETH/SOL/XRP/DOGE/CRO/SUI/ATOM. Pass `symbol` for one asset or omit for the top movers.',
  parameters: {
    type: 'object',
    properties: {
      symbol: { type: 'string', description: 'Optional single asset ticker (case-insensitive). If omitted, returns top movers.' },
      topN: { type: 'number', description: 'When `symbol` is omitted, number of top-by-24h-volume movers to return. Default 8, max 20.' },
    },
    additionalProperties: false,
  },
  async execute({ symbol, topN }) {
    const cacheKey = 'broader-tickers';
    const now = Date.now();
    let tickers = _broaderCache.value;
    if (!tickers || now - _broaderCache.at > BROADER_CACHE_TTL_MS) {
      try {
        const r = await fetch('https://api.crypto.com/exchange/v1/public/get-tickers', {
          signal: AbortSignal.timeout(5000),
        });
        if (!r.ok) throw new Error(`crypto.com HTTP ${r.status}`);
        const j = await r.json() as { result?: { data?: Array<Record<string, string>> } };
        const raw = j.result?.data ?? [];
        tickers = raw
          .filter((t) => String(t.i || '').endsWith('_USDT'))
          .map((t) => {
            const symbol = String(t.i || '').replace('_USDT', '').toUpperCase();
            const ask = parseFloat(t.a || '0');
            const bid = parseFloat(t.b || '0');
            const price = (ask > 0 && bid > 0) ? (ask + bid) / 2 : (ask || bid);
            const change24hPct = parseFloat(t.c || '0') * 100;
            const volume24hUsd = parseFloat(t.v || '0') * (price || 0);
            return { symbol, price, change24hPct, volume24hUsd };
          })
          .filter((t) => Number.isFinite(t.price) && t.price > 0);
        _broaderCache = { at: now, value: tickers };
      } catch (e) {
        // Fail-open: return whatever's cached even if stale, else empty
        if (!tickers) throw new Error(`broader market fetch failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (symbol) {
      const s = symbol.toUpperCase();
      const hit = tickers.find((t) => t.symbol === s);
      return { symbol: hit ?? { error: `${s} not found on Crypto.com` } };
    }
    const n = Math.max(1, Math.min(20, topN ?? 8));
    return {
      top: tickers
        .sort((a, b) => b.volume24hUsd - a.volume24hUsd)
        .slice(0, n),
    };
  },
};

// Serverless-scoped cache for the Crypto.com tickers response — one HTTP
// call feeds every concurrent chat within the TTL. 30s matches the
// Crypto.com ticker cache tag used elsewhere.
const BROADER_CACHE_TTL_MS = 30_000;
let _broaderCache: { at: number; value: Array<{ symbol: string; price: number; change24hPct: number; volume24hUsd: number }> | null } = { at: 0, value: null };

/**
 * Unified per-asset context — one tool call returns everything the LLM
 * needs to answer "how is X doing" / "what's happening with X" style
 * questions comprehensively in a single response.
 *
 * Returns (best-effort — each sub-fetch fails independently):
 *   price       — spot from validated multi-source aggregator (BTC/ETH/SOL/XRP/DOGE/CRO/SUI/ATOM)
 *                 OR Crypto.com direct fallback for any other ticker
 *   change24hPct — 24h percent change (Crypto.com)
 *   volume24hUsd — 24h volume in USD (Crypto.com)
 *   signal      — fused prediction-market signal (tracked assets only): direction, confidence, consensus, recommendation, sourceCount
 *   recentHedges — last 3 vault hedges on this asset (real, not paper), most recent first
 *
 * This is THE tool for any single-asset question. LLM should prefer this
 * over calling get_asset_price + get_prediction_signal + query_hedge_history
 * separately. One round-trip instead of three.
 */
const getAssetContext: AgentTool<
  { asset: string },
  {
    asset: string;
    price: number | null;
    priceConfidence?: string;
    priceSources?: number;
    change24hPct: number | null;
    volume24hUsd: number | null;
    signal: null | {
      direction: 'UP' | 'DOWN' | 'NEUTRAL';
      confidence: number;
      consensus: number;
      recommendation: string;
      sourceCount: number;
      reasoning: string;
    };
    recentHedges: Array<{
      orderId: string;
      side: string;
      notionalUsd: number;
      status: string;
      realizedPnlUsd: number | null;
      openedAt: string;
      closedAt: string | null;
    }>;
    isTracked: boolean;
  }
> = {
  name: 'get_asset_context',
  description:
    'Return EVERYTHING about one crypto asset in one call: price, 24h change, volume, prediction signal (if tracked), recent vault hedges. Use this for "how is X doing", "what\'s happening with X", "give me an update on X" — never call get_asset_price + get_prediction_signal + query_hedge_history separately when this covers all three.',
  parameters: {
    type: 'object',
    properties: {
      asset: { type: 'string', description: 'Asset ticker (BTC, ETH, DOGE, ADA, anything).' },
    },
    required: ['asset'],
    additionalProperties: false,
  },
  async execute({ asset }) {
    const symbol = asset.toUpperCase();
    const TRACKED = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'CRO', 'SUI', 'ATOM'];
    const isTracked = TRACKED.includes(symbol);

    // Fire all sub-fetches in parallel — each fails independently.
    const [priceRes, broaderRes, signalRes, hedgesRes] = await Promise.allSettled([
      isTracked
        ? (async () => {
            const { getMultiSourceValidatedPrice } = await import('@/lib/services/market-data/unified-price-provider');
            return await getMultiSourceValidatedPrice(symbol);
          })()
        : Promise.resolve(null),
      getBroaderMarket.execute({ symbol }),
      isTracked
        ? (async () => {
            const { PredictionAggregatorService } = await import('@/lib/services/market-data/PredictionAggregatorService');
            const preds = await PredictionAggregatorService.getPerAssetPredictions([symbol]);
            return preds[symbol] ?? null;
          })()
        : Promise.resolve(null),
      (async () => {
        const { query } = await import('@/lib/db/postgres');
        const rows = await query<{
          order_id: string; side: string; notional_value: string; status: string;
          realized_pnl: string | null; created_at: Date; closed_at: Date | null;
        }>(
          `SELECT order_id, side, notional_value, status,
                  realized_pnl, created_at, closed_at
           FROM hedges
           WHERE asset = $1 AND ${HEDGES_REAL_ONLY_SQL}
           ORDER BY created_at DESC LIMIT 3`,
          [symbol],
        );
        return rows;
      })(),
    ]);

    // Assemble. Price prefers validated tracked-asset source; falls back to Crypto.com from broader.
    const priceData = priceRes.status === 'fulfilled' && priceRes.value
      ? { price: priceRes.value.price, confidence: priceRes.value.confidence, sources: priceRes.value.sources.length }
      : null;
    const broader = broaderRes.status === 'fulfilled' ? broaderRes.value : null;
    const broaderHit = broader && 'symbol' in broader && broader.symbol && !('error' in broader.symbol)
      ? (broader.symbol as { price: number; change24hPct: number; volume24hUsd: number })
      : null;
    const pred = signalRes.status === 'fulfilled' ? signalRes.value : null;
    const hedges = hedgesRes.status === 'fulfilled' ? hedgesRes.value : [];

    return {
      asset: symbol,
      price: priceData?.price ?? broaderHit?.price ?? null,
      priceConfidence: priceData?.confidence,
      priceSources: priceData?.sources,
      change24hPct: broaderHit?.change24hPct ?? null,
      volume24hUsd: broaderHit?.volume24hUsd ?? null,
      signal: pred
        ? {
            direction: pred.direction,
            confidence: Math.round(pred.confidence),
            consensus: Math.round(pred.consensus),
            recommendation: pred.recommendation,
            sourceCount: pred.sources.length,
            reasoning: pred.reasoning.slice(0, 240),
          }
        : null,
      recentHedges: hedges.map((h) => ({
        orderId: h.order_id,
        side: h.side,
        notionalUsd: Number(h.notional_value),
        status: h.status,
        realizedPnlUsd: h.realized_pnl !== null ? Number(h.realized_pnl) : null,
        openedAt: h.created_at.toISOString(),
        closedAt: h.closed_at?.toISOString() ?? null,
      })),
      isTracked,
    };
  },
};

/**
 * DefiLlama TVL — protocol total-value-locked from the industry-standard
 * DefiLlama free API. Covers ~2000 protocols across all chains. Use when
 * a user asks about TVL, protocol size, "how big is X", or wants to
 * compare protocols. Also returns the protocol's category, chain
 * distribution, and 24h/7d/30d TVL change.
 *
 * Slug matching is exact (DefiLlama's URL slug — 'uniswap', 'aave',
 * 'curve-dex', 'lido'). Fuzzy match against the full protocol list on
 * miss. 60s cache.
 */
const getDefiLlamaTvl: AgentTool<
  { protocol: string },
  {
    protocol: string;
    tvlUsd: number;
    change1h?: number;
    change1d?: number;
    change7d?: number;
    chains: string[];
    category: string;
    mcapUsd?: number | null;
  } | { error: string; suggestions?: string[] }
> = {
  name: 'get_defi_tvl',
  description:
    'Fetch total value locked (TVL) + category + chains + TVL changes (1h/1d/7d) for a DeFi protocol from DefiLlama. Use for "how big is Aave", "what\'s TVL of Uniswap", "compare Curve and Balancer" style questions. Protocol slug is lowercase kebab (uniswap, aave, curve-dex, lido, rocket-pool). Suggests close matches if not found.',
  parameters: {
    type: 'object',
    properties: {
      protocol: { type: 'string', description: 'DefiLlama slug — lowercase kebab. Examples: uniswap, aave, curve-dex, lido, gmx, pendle.' },
    },
    required: ['protocol'],
    additionalProperties: false,
  },
  async execute({ protocol }) {
    const slug = protocol.toLowerCase().trim();
    try {
      const r = await fetch(`https://api.llama.fi/protocol/${encodeURIComponent(slug)}`, {
        signal: AbortSignal.timeout(6000),
      });
      if (!r.ok) {
        // Try to fetch full list + suggest closest matches
        try {
          const list = await (await fetch('https://api.llama.fi/protocols', { signal: AbortSignal.timeout(6000) })).json() as Array<{ slug: string; name: string }>;
          const query = slug;
          const suggestions = list
            .filter((p) => p.slug.includes(query) || p.name.toLowerCase().includes(query))
            .slice(0, 5)
            .map((p) => p.slug);
          return { error: `protocol '${slug}' not found on DefiLlama (HTTP ${r.status})`, suggestions };
        } catch {
          return { error: `protocol '${slug}' not found on DefiLlama (HTTP ${r.status})` };
        }
      }
      const p = await r.json() as {
        name: string;
        currentChainTvls?: Record<string, number>;
        change_1h?: number; change_1d?: number; change_7d?: number;
        category?: string;
        mcap?: number | null;
      };
      const chainTvls = p.currentChainTvls ?? {};
      const chains = Object.keys(chainTvls).filter((c) => !c.includes('-') && chainTvls[c] > 0);
      const tvlUsd = Object.values(chainTvls).reduce((s, v) => s + (Number.isFinite(v) ? v : 0), 0);
      return {
        protocol: p.name,
        tvlUsd: Math.round(tvlUsd),
        change1h: p.change_1h ?? undefined,
        change1d: p.change_1d ?? undefined,
        change7d: p.change_7d ?? undefined,
        chains,
        category: p.category ?? 'unknown',
        mcapUsd: p.mcap ?? null,
      };
    } catch (e) {
      return { error: `DefiLlama fetch failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  },
};

/**
 * Crypto Fear & Greed Index — the industry-standard sentiment gauge
 * (0-100, higher = more greed). Free API, updated once per day.
 * 60s cache so concurrent chats share one HTTP call.
 */
let _fngCache: { at: number; value: { value: number; classification: string; updatedAt: string } | null } = { at: 0, value: null };
const FNG_CACHE_TTL_MS = 60_000;

const getFearGreedIndex: AgentTool<
  Record<string, never>,
  { value: number; classification: string; updatedAt: string } | { error: string }
> = {
  name: 'get_fear_greed_index',
  description:
    'Crypto Fear & Greed Index (0-100, Extreme Fear → Extreme Greed). Industry-standard daily sentiment gauge. Use for "what\'s market sentiment", "are people greedy or fearful", "F&G today".',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  async execute() {
    const now = Date.now();
    if (_fngCache.value && now - _fngCache.at < FNG_CACHE_TTL_MS) return _fngCache.value;
    try {
      const r = await fetch('https://api.alternative.me/fng/?limit=1', {
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) return { error: `F&G API HTTP ${r.status}` };
      const j = await r.json() as { data?: Array<{ value: string; value_classification: string; timestamp: string }> };
      const row = j.data?.[0];
      if (!row) return { error: 'F&G API returned no data' };
      const value = {
        value: Number(row.value),
        classification: row.value_classification,
        updatedAt: new Date(Number(row.timestamp) * 1000).toISOString(),
      };
      _fngCache = { at: now, value };
      return value;
    } catch (e) {
      return { error: `F&G fetch failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  },
};

/**
 * Crypto news / trending tool — CoinGecko `/search/trending` (free, no
 * key). Returns top-7 trending coins by search volume + top-3 NFTs +
 * top-3 categories. Used for 'what's hot', 'trending coins',
 * 'what news moved BTC' style questions.
 *
 * 5-min cache. CoinGecko is generous but rate-limits under sustained load.
 */
let _trendingCache: { at: number; value: { coins: Array<{ symbol: string; name: string; rank: number; priceUsd: number }>; categories: string[] } | null } = { at: 0, value: null };
const TRENDING_CACHE_TTL_MS = 5 * 60 * 1000;

const getCryptoNews: AgentTool<
  Record<string, never>,
  { coins: Array<{ symbol: string; name: string; rank: number; priceUsd: number }>; categories: string[] } | { error: string }
> = {
  name: 'get_crypto_news',
  description:
    "Trending crypto coins + top NFT collections + hot narrative categories from CoinGecko. Use for 'what's hot right now', 'what's trending', 'crypto news today', 'any breaking news'. Fast — 5-min cached.",
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  async execute() {
    const now = Date.now();
    if (_trendingCache.value && now - _trendingCache.at < TRENDING_CACHE_TTL_MS) return _trendingCache.value;
    try {
      const r = await fetch('https://api.coingecko.com/api/v3/search/trending', { signal: AbortSignal.timeout(6000) });
      if (!r.ok) return { error: `CoinGecko trending HTTP ${r.status}` };
      const j = await r.json() as {
        coins?: Array<{ item?: { symbol: string; name: string; market_cap_rank?: number; data?: { price?: number } } }>;
        categories?: Array<{ name: string }>;
      };
      const coins = (j.coins ?? []).slice(0, 7).map((c) => {
        const it = c.item ?? { symbol: '', name: '' };
        return {
          symbol: (it.symbol || '').toUpperCase(),
          name: it.name || '',
          rank: it.market_cap_rank ?? 0,
          priceUsd: Number(it.data?.price ?? 0),
        };
      });
      const categories = (j.categories ?? []).slice(0, 3).map((c) => c.name);
      const value = { coins, categories };
      _trendingCache = { at: now, value };
      return value;
    } catch (e) {
      return { error: `trending fetch failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  },
};

/**
 * Historical price summary — CoinGecko `/coins/{id}/market_chart` (free,
 * no key). Returns high/low/current + % change over the window. Coingecko
 * `id` for common assets is the full name lowercased ('bitcoin', 'ethereum',
 * 'solana', etc). We handle the common tickers explicitly.
 *
 * Use for 'BTC over the last week', 'ETH from ATH', 'SOL 30-day range'.
 */
const COINGECKO_ID: Record<string, string> = {
  BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', XRP: 'ripple',
  DOGE: 'dogecoin', ADA: 'cardano', DOT: 'polkadot', AVAX: 'avalanche-2',
  LINK: 'chainlink', MATIC: 'polygon', BNB: 'binancecoin', LTC: 'litecoin',
  TRX: 'tron', TON: 'the-open-network', SUI: 'sui', ATOM: 'cosmos',
  ARB: 'arbitrum', OP: 'optimism', APT: 'aptos', INJ: 'injective-protocol',
  UNI: 'uniswap', AAVE: 'aave', PEPE: 'pepe', SHIB: 'shiba-inu',
  ONDO: 'ondo-finance', WIF: 'dogwifcoin', BONK: 'bonk',
};

const getHistoricalSummary: AgentTool<
  { asset: string; days?: number },
  {
    asset: string; days: number;
    currentPrice: number; high: number; low: number;
    changePct: number; startPrice: number;
    dataPoints: number;
  } | { error: string; suggestions?: string[] }
> = {
  name: 'get_historical_summary',
  description:
    "Historical price summary for an asset over N days (default 7). Returns current + high + low + % change. Use for 'BTC last week', 'ETH from ATH', 'SOL 30-day range', 'how has X moved recently'. Supports common tickers (BTC/ETH/SOL/etc); if unknown, suggests close matches.",
  parameters: {
    type: 'object',
    properties: {
      asset: { type: 'string', description: 'Asset ticker (BTC/ETH/SOL/DOGE/ADA/etc).' },
      days: { type: 'number', description: 'Lookback window in days. Default 7. Max 365.' },
    },
    required: ['asset'],
    additionalProperties: false,
  },
  async execute({ asset, days = 7 }) {
    const symbol = asset.toUpperCase();
    const id = COINGECKO_ID[symbol];
    if (!id) {
      return { error: `${symbol} not in the historical-data whitelist`, suggestions: Object.keys(COINGECKO_ID).slice(0, 10) };
    }
    const clampedDays = Math.max(1, Math.min(365, days));
    try {
      const r = await fetch(
        `https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=${clampedDays}`,
        { signal: AbortSignal.timeout(8000) },
      );
      if (!r.ok) return { error: `CoinGecko HTTP ${r.status} for ${symbol}` };
      const j = await r.json() as { prices?: Array<[number, number]> };
      const prices = j.prices ?? [];
      if (prices.length < 2) return { error: `no historical data returned for ${symbol}` };
      const values = prices.map((p) => p[1]);
      const startPrice = values[0];
      const currentPrice = values[values.length - 1];
      const high = Math.max(...values);
      const low = Math.min(...values);
      const changePct = ((currentPrice - startPrice) / startPrice) * 100;
      return {
        asset: symbol, days: clampedDays,
        currentPrice, high, low, changePct, startPrice,
        dataPoints: prices.length,
      };
    } catch (e) {
      return { error: `historical fetch failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  },
};

/**
 * On-chain snapshot — ETH gas (Owlracle, free) + DefiLlama chain TVL
 * breakdown. Use for 'gas fees now', 'what's ETH gas', 'TVL by chain',
 * 'L2 growth', 'which chain is biggest'.
 *
 * 60s cache on both since gas + chain TVLs move slowly.
 */
let _onchainCache: { at: number; value: { gasGwei: { fast: number; normal: number; slow: number; baseFee: number } | null; chains: Array<{ name: string; tvlUsdB: number; changePct1d?: number; changePct7d?: number }> } | null } = { at: 0, value: null };
const ONCHAIN_CACHE_TTL_MS = 60_000;

const getOnchainSnapshot: AgentTool<
  { topN?: number },
  {
    gasGwei: { fast: number; normal: number; slow: number; baseFee: number } | null;
    chains: Array<{ name: string; tvlUsdB: number; changePct1d?: number; changePct7d?: number }>;
  } | { error: string }
> = {
  name: 'get_onchain_snapshot',
  description:
    "ETH gas prices (fast/normal/slow gwei + base fee) + top-N chains by TVL from DefiLlama with 1d/7d changes. Use for 'gas fees', 'gas now', 'what chain is biggest', 'L2 TVL', 'chain growth'.",
  parameters: {
    type: 'object',
    properties: {
      topN: { type: 'number', description: 'How many top chains to return (default 6, max 20).' },
    },
    additionalProperties: false,
  },
  async execute({ topN }) {
    const now = Date.now();
    if (_onchainCache.value && now - _onchainCache.at < ONCHAIN_CACHE_TTL_MS) {
      const n = Math.max(1, Math.min(20, topN ?? 6));
      return { gasGwei: _onchainCache.value.gasGwei, chains: _onchainCache.value.chains.slice(0, n) };
    }
    // Timeouts bumped from 6s to 10s: prod-side E2E test on 2026-09-22
    // showed 'eth gas fees now' returned "unavailable" because Owlracle
    // occasionally takes 7-9s on cold connect. 10s tolerates the tail
    // without stalling the chat unreasonably (still well under the LLM's
    // per-tool budget).
    const [gasRes, chainsRes] = await Promise.allSettled([
      (async () => {
        const r = await fetch('https://api.owlracle.info/v2/eth/gas', { redirect: 'follow', signal: AbortSignal.timeout(10000) });
        if (!r.ok) return null;
        const j = await r.json() as { baseFee?: number; speeds?: Array<{ acceptance: number; gasPrice: number }> };
        if (!j.speeds || j.speeds.length < 3) return null;
        return {
          fast: Math.round((j.speeds.find((s) => s.acceptance >= 0.9) ?? j.speeds[2]).gasPrice * 100) / 100,
          normal: Math.round((j.speeds.find((s) => s.acceptance >= 0.6) ?? j.speeds[1]).gasPrice * 100) / 100,
          slow: Math.round((j.speeds.find((s) => s.acceptance >= 0.35) ?? j.speeds[0]).gasPrice * 100) / 100,
          baseFee: Math.round((j.baseFee ?? 0) * 100) / 100,
        };
      })(),
      (async () => {
        const r = await fetch('https://api.llama.fi/chains', { signal: AbortSignal.timeout(10000) });
        if (!r.ok) return [];
        const arr = await r.json() as Array<{ name: string; tvl: number; change_1d?: number; change_7d?: number }>;
        return arr
          .filter((c) => c.tvl > 0)
          .sort((a, b) => b.tvl - a.tvl)
          .slice(0, 20)
          .map((c) => ({
            name: c.name,
            tvlUsdB: Math.round(c.tvl / 1e7) / 100, // 2 decimals, in $B
            changePct1d: typeof c.change_1d === 'number' ? Math.round(c.change_1d * 10) / 10 : undefined,
            changePct7d: typeof c.change_7d === 'number' ? Math.round(c.change_7d * 10) / 10 : undefined,
          }));
      })(),
    ]);
    const gasGwei = gasRes.status === 'fulfilled' ? gasRes.value : null;
    const chains = chainsRes.status === 'fulfilled' ? chainsRes.value : [];
    const value = { gasGwei, chains };
    _onchainCache = { at: now, value };
    const n = Math.max(1, Math.min(20, topN ?? 6));
    return { gasGwei, chains: chains.slice(0, n) };
  },
};

/**
 * Options market snapshot — Deribit public API, no auth. Returns
 * BTC or ETH options: max pain, put/call ratio, average IV, and top
 * open-interest strikes. Use for 'BTC options', 'IV', 'put call ratio',
 * 'options market sentiment'.
 *
 * 2-min cache — options data updates every minute or so.
 */
let _optionsCache: Map<string, { at: number; value: { asset: string; totalOI: number; putCallRatio: number; avgIV: number; underlyingPrice: number; topStrikes: Array<{ strike: number; type: 'C' | 'P'; oi: number; iv: number }> } | null }> = new Map();
const OPTIONS_CACHE_TTL_MS = 120_000;

const getOptionsData: AgentTool<
  { asset: 'BTC' | 'ETH' },
  {
    asset: string; totalOI: number; putCallRatio: number; avgIV: number;
    underlyingPrice: number;
    topStrikes: Array<{ strike: number; type: 'C' | 'P'; oi: number; iv: number }>;
  } | { error: string }
> = {
  name: 'get_options_data',
  description:
    "Options market data for BTC or ETH from Deribit — total open interest, put/call ratio, avg implied volatility, underlying price, and top 5 strikes by OI. Use for 'BTC IV', 'put call ratio', 'options market read', 'where are the big strikes'.",
  parameters: {
    type: 'object',
    properties: {
      asset: { type: 'string', description: "'BTC' or 'ETH' — the only two Deribit crypto option series." },
    },
    required: ['asset'],
    additionalProperties: false,
  },
  async execute({ asset }) {
    const symbol = asset.toUpperCase();
    if (symbol !== 'BTC' && symbol !== 'ETH') {
      return { error: 'Options only available for BTC and ETH via Deribit.' };
    }
    const now = Date.now();
    const cached = _optionsCache.get(symbol);
    if (cached && cached.value && now - cached.at < OPTIONS_CACHE_TTL_MS) return cached.value;
    try {
      const r = await fetch(
        `https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=${symbol}&kind=option`,
        { signal: AbortSignal.timeout(10000) },
      );
      if (!r.ok) return { error: `Deribit HTTP ${r.status}` };
      const j = await r.json() as { result?: Array<{
        instrument_name: string; open_interest: number; mark_iv?: number;
        underlying_price?: number;
      }> };
      const results = j.result ?? [];
      if (results.length === 0) return { error: 'Deribit returned no options data' };
      let totalOI = 0, calls = 0, puts = 0, ivSum = 0, ivCount = 0;
      let underlyingPrice = 0;
      const strikeMap = new Map<string, { strike: number; type: 'C' | 'P'; oi: number; iv: number }>();
      for (const item of results) {
        // Instrument format: 'BTC-26MAR27-40000-C' or '-P'
        const parts = item.instrument_name.split('-');
        if (parts.length !== 4) continue;
        const strike = Number(parts[2]);
        const type = parts[3] as 'C' | 'P';
        if (!Number.isFinite(strike) || (type !== 'C' && type !== 'P')) continue;
        const oi = Number(item.open_interest) || 0;
        const iv = Number(item.mark_iv) || 0;
        totalOI += oi;
        if (type === 'C') calls += oi;
        else puts += oi;
        if (iv > 0) { ivSum += iv; ivCount++; }
        if (item.underlying_price && !underlyingPrice) underlyingPrice = item.underlying_price;
        const key = `${strike}-${type}`;
        const existing = strikeMap.get(key);
        if (existing) {
          existing.oi += oi;
          if (iv > 0) existing.iv = (existing.iv + iv) / 2;
        } else {
          strikeMap.set(key, { strike, type, oi, iv });
        }
      }
      const topStrikes = Array.from(strikeMap.values())
        .sort((a, b) => b.oi - a.oi)
        .slice(0, 5)
        .map((s) => ({ ...s, iv: Math.round(s.iv * 10) / 10 }));
      const value = {
        asset: symbol,
        totalOI: Math.round(totalOI),
        putCallRatio: calls > 0 ? Math.round((puts / calls) * 100) / 100 : 0,
        avgIV: ivCount > 0 ? Math.round((ivSum / ivCount) * 10) / 10 : 0,
        underlyingPrice: Math.round(underlyingPrice),
        topStrikes,
      };
      _optionsCache.set(symbol, { at: now, value });
      return value;
    } catch (e) {
      return { error: `options fetch failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  },
};

/** Public registry — the default tool set every Layer 3 agent gets. */
export const DEFAULT_AGENT_TOOLS: AgentTool[] = [
  getAssetContext,          // PREFERRED for single-asset questions
  queryRecentInterpretations,
  queryHedgeHistory,
  getAssetPrice,
  getMarketSnapshot,
  getPredictionSignal,
  getCronStateSnapshot,
  queryPostmortemStats,
  getTreasuryStateTool,
  getBroaderMarket,
  getDefiLlamaTvl,
  getFearGreedIndex,
  getCryptoNews,            // NEW 2026-09-22: trending coins + hot narratives (CoinGecko)
  getHistoricalSummary,     // NEW 2026-09-22: N-day high/low/change (CoinGecko market_chart)
  getOnchainSnapshot,       // NEW 2026-09-22: ETH gas + top-chain TVL (Owlracle + DefiLlama)
  getOptionsData,           // NEW 2026-09-22: BTC/ETH options IV + put/call + top strikes (Deribit)
] as AgentTool[];

/** Look up a tool by name — used by the runner to dispatch. */
export function toolByName(tools: AgentTool[], name: string): AgentTool | undefined {
  return tools.find((t) => t.name === name);
}

/** Convert our internal tool shape to the OpenAI tool-schema payload. */
export function toolsToOpenAiSchema(tools: AgentTool[]) {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

export async function runTool(
  tool: AgentTool,
  args: Record<string, unknown>,
): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  try {
    const result = await tool.execute(args);
    return { ok: true, result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('[AgentTools] tool failed', { name: tool.name, args, error: msg });
    return { ok: false, error: msg };
  }
}
