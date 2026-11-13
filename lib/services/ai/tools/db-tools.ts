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

const PAPER_BOOKS = [
  { id: -3, name: 'PaperTrader', tests: 'the full signal strategy; opens only signals the ledger has proven' },
  { id: -4, name: 'PaperGated', tests: 'the same strategy with entry gates removed one at a time' },
  { id: -5, name: 'Oracle', tests: 'every fresh model interpretation at its own horizon; switched off since 2026-10-19' },
  { id: -6, name: 'Solana sleeve', tests: 'a sleeve sized off the Solana test pool' },
  { id: -7, name: 'LeadTrader', tests: 'one ledger source (Kalshi, BTC and ETH) held to its 240-minute horizon' },
  { id: -8, name: 'FloorTrader', tests: 'long BTC and ETH sized to keep the book above 90% of its peak; no signal' },
  { id: -9, name: 'FloorLadderTrader', tests: 'the floor rule sized by the move the strike ladder prices' },
  { id: -10, name: 'TrendTrader', tests: 'BTC and ETH, each held as spot at 12.5% of the book while its last daily close is above its 100-day average, decided once a day; few trades by design' },
  { id: -11, name: 'CoreTrader', tests: 'the floor rule (BTC and ETH sized to keep the book above 90% of its peak) holding a coin only while it is above its 100-day average, as spot; its cash is credited an assumed 4% a year' },
  { id: -12, name: 'ShortTrader', tests: 'the core rule turned down: BTC and ETH sold short on the perp, sized by the floor rule, while a coin is below its 100-day average and below its close 30 days before; cash otherwise, credited an assumed 4% a year' },
] as const;
/** Books whose cash is credited interest that no row holds, and where it is kept. */
const INTEREST_STATE: Readonly<Record<number, string>> = { [-11]: 'core-trader:state', [-12]: 'short-trader:state' };

export const getPaperBooks: AgentTool<
  { hours?: number },
  Array<{
    portfolioId: number;
    name: string;
    tests: string;
    closed: { trades: number; wins: number; realizedUsd: number; avgBp: number };
    open: { positions: number; notionalUsd: number; openPnlUsd: number };
    /** CoreTrader and ShortTrader only: interest credited to the cash since the start, which no row holds. */
    interestUsd?: number;
  }>
> = {
  name: 'get_paper_books',
  description:
    'Simulated (paper) books: for each one, what it tests, its closed trades over the lookback (count, wins, realized USD, average trade in bp of notional) net of fees, slippage and funding, and its open positions marked to market net of the opening costs and funding so far but before the exit cost, read from its rows. CoreTrader and ShortTrader also report the interest credited to their cash since they started (assumed, 4% a year, in no row): their result is closed plus open plus interest. These are simulations, never real returns. A win rate means nothing without the average trade.',
  parameters: {
    type: 'object',
    properties: {
      hours: { type: 'number', description: 'Lookback for closed trades in hours. Default 720 (30d), max 8760.' },
    },
    additionalProperties: false,
  },
  async execute({ hours = 720 }) {
    const [{ query }, { bookRowStats }, { getCronStateStrict }] = await Promise.all([
      import('@/lib/db/postgres'),
      import('@/lib/db/book-row-stats'),
      import('@/lib/db/cron-state'),
    ]);
    const sinceMs = Date.now() - Math.min(Math.max(1, hours), 8760) * 60 * 60 * 1000;
    const ids = PAPER_BOOKS.map((b) => b.id);
    const [open, stats, interest] = await Promise.all([
      query<{ portfolio_id: number; n: number; notional: number; pnl: number }>(
        `SELECT portfolio_id, COUNT(*)::int AS n,
                COALESCE(SUM(notional_value), 0)::float8 AS notional,
                COALESCE(SUM(current_pnl), 0)::float8 AS pnl
           FROM hedges
          WHERE portfolio_id = ANY($1) AND status = 'active'
          GROUP BY portfolio_id`,
        [ids],
      ),
      Promise.all(ids.map((id) => bookRowStats(id, sinceMs))),
      Promise.all(PAPER_BOOKS.map((b) => (INTEREST_STATE[b.id] ? getCronStateStrict<{ interestUsd?: number }>(INTEREST_STATE[b.id]) : null))),
    ]);
    return PAPER_BOOKS.map((b, i) => {
      const s = stats[i];
      if (!s) throw new Error(`could not read the closed trades of book ${b.id}`);
      const o = open.find((r) => Number(r.portfolio_id) === b.id);
      return {
        portfolioId: b.id,
        name: b.name,
        tests: b.tests,
        closed: { trades: s.trades, wins: s.wins, realizedUsd: s.realizedUsd, avgBp: s.avgBp },
        open: { positions: o?.n ?? 0, notionalUsd: o?.notional ?? 0, openPnlUsd: o?.pnl ?? 0 },
        ...(INTEREST_STATE[b.id] ? { interestUsd: Number(interest[i]?.interestUsd ?? 0) } : {}),
      };
    });
  },
};

type PoolSnap = { at: string; sharePrice: number; navUsd: number };

export const getPools: AgentTool<
  Record<string, never>,
  Array<{
    pool: string;
    network: string;
    money: string;
    now: PoolSnap & { members?: number };
    membersPaidInUsd?: number;
    tradingEnabled?: boolean;
  }>
> = {
  name: 'get_pools',
  description:
    'The deposit pools: for each, its network, whether it holds real money, and the latest NAV and share price with the snapshot time. For the SUI pool also what its members paid in (cost basis): NAV below that is what the members have lost. NAV counts the pool contract, the admin wallet and the trading venue account. Read from the NAV snapshots and member rows.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  async execute() {
    const [{ query }, { isPoolTradingEnabled }] = await Promise.all([
      import('@/lib/db/postgres'),
      import('@/lib/services/sui/pool-trading-pause'),
    ]);
    type Row = { at: Date | string; sp: number; nav: number; members?: number };
    // No history comparison: SUI snapshots from 2026-10-01 to 10-06 carry a wrong share price.
    const [[sui], [sol], [basis]] = await Promise.all([
      query<Row>(
        `SELECT timestamp AS at, share_price::float8 AS sp, total_nav::float8 AS nav, member_count AS members
           FROM community_pool_nav_history WHERE chain = 'sui' ORDER BY timestamp DESC LIMIT 1`,
      ),
      query<Row>(
        `SELECT recorded_at AS at, share_price AS sp, nav_usd AS nav
           FROM solana_pool_nav_history WHERE cluster = 'devnet' AND nav_usd IS NOT NULL
          ORDER BY recorded_at DESC LIMIT 1`,
      ),
      query<{ usd: number | null }>(
        `SELECT SUM(cost_basis_usd)::float8 AS usd FROM community_pool_shares WHERE chain = 'sui' AND shares > 0`,
      ),
    ]);
    if (!sui) throw new Error('could not read the SUI pool NAV');
    if (!sol) throw new Error('could not read the Solana pool NAV');
    if (basis?.usd == null) throw new Error('could not read the SUI pool members');
    const snap = (r: Row): PoolSnap => ({ at: new Date(r.at).toISOString(), sharePrice: Number(r.sp), navUsd: Number(r.nav) });
    return [
      {
        pool: 'SUI USDC pool',
        network: 'SUI mainnet',
        money: 'real USDC, deposits capped at $10K by the contract',
        now: { ...snap(sui), members: Number(sui.members) },
        membersPaidInUsd: Number(basis.usd),
        tradingEnabled: isPoolTradingEnabled(),
      },
      {
        pool: 'Solana test pool',
        network: 'Solana devnet',
        money: 'test tokens only, no real money',
        now: snap(sol),
      },
    ];
  },
};

export const getResearchDesk: AgentTool<Record<string, never>, unknown> = {
  name: 'get_research_desk',
  description:
    'The research desk, where this model proposes trading rules each round and code tests them on daily BTC and ETH closes net of costs. Returns how many rules were tried, the leading rule with its training score and its score on the held-out year the model never saw, whether it passes the bar (which rises with every rule tried), our live trend rule scored the same way, and the latest rules. edgeT is the t-statistic of the timing over simply holding the same share: about 2 or more is evidence, near 0 is none.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  async execute() {
    const { readDesk } = await import('@/lib/services/ai/research-desk');
    return readDesk();
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

/**
 * The public chat runs this tool, so it reads only what the site already shows: job heartbeats, halts and pool
 * peaks. The alert log and the rest of cron_state hold raw error text and internal state that the risk page keeps back.
 */
export const CHAT_READABLE_STATE_PREFIXES = ['cron:lastRun:', 'cron:haltUntil:', 'cron:haltReason:', 'poolNav:peak:'] as const;

export const getCronStateSnapshot: AgentTool<
  { key: string },
  { key: string; value: unknown; exists: boolean }
> = {
  name: 'get_cron_state',
  description:
    'Read one job-state key: when a job last ran ("cron:lastRun:<job>", epoch ms), whether it is halted and why ("cron:haltUntil:<job>", "cron:haltReason:<job>", e.g. "cron:haltUntil:sui-community-pool:autohedge"), or a pool\'s peak value ("poolNav:peak:<pool>"). No other key is readable.',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Exact key, starting with cron:lastRun:, cron:haltUntil:, cron:haltReason: or poolNav:peak:' },
    },
    required: ['key'],
    additionalProperties: false,
  },
  async execute({ key }) {
    if (!CHAT_READABLE_STATE_PREFIXES.some((p) => key.startsWith(p))) {
      throw new Error(`"${key}" is not readable here; only ${CHAT_READABLE_STATE_PREFIXES.join(', ')} keys are`);
    }
    const { getCronStateStrict } = await import('@/lib/db/cron-state');
    const value = await getCronStateStrict(key);
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
       WHERE outcome_linked_at IS NOT NULL AND outcome_linked_at >= $1
         AND (yes_price IS NOT NULL OR direction IN ('BINARY_YES', 'BINARY_NO'))`,
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
