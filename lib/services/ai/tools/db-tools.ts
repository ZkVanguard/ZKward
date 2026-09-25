/**
 * DB-backed agent tools — read-only Postgres queries for reasoning agents.
 * All queries are bounded by row cap + lookback window. No mutations.
 */

import { HEDGES_REAL_ONLY_SQL } from '@/lib/db/hedges-scope';
import type { AgentTool } from './types';

export const queryRecentInterpretations: AgentTool<
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

export const queryHedgeHistory: AgentTool<
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

export const getCronStateSnapshot: AgentTool<
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

// Serverless-scoped cache. Dies with the lambda, which is fine — first
// request after cold-start pays the DB hit, subsequent requests within
// TTL are instant.
const POSTMORTEM_CACHE_TTL_MS = 5 * 60 * 1000;
const _postmortemCache = new Map<
  string,
  { at: number; value: { total: number; resolved: number; correct: number; wrong: number; accuracy: number } }
>();

export const queryPostmortemStats: AgentTool<
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

export const getTreasuryStateTool: AgentTool<
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
