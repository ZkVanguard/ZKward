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
    return {
      total,
      resolved,
      correct,
      wrong,
      accuracy: resolved > 0 ? correct / resolved : 0,
    };
  },
};

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

/** Public registry — the default tool set every Layer 3 agent gets. */
export const DEFAULT_AGENT_TOOLS: AgentTool[] = [
  queryRecentInterpretations,
  queryHedgeHistory,
  getAssetPrice,
  getMarketSnapshot,
  getPredictionSignal,
  getCronStateSnapshot,
  queryPostmortemStats,
  getTreasuryStateTool,
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
