/**
 * Platform Risk Overview API
 *
 * Public, investor-facing aggregation of platform-wide risk metrics. Mirrors
 * BlackRock's Aladdin client-portal model: one endpoint, everything an LP or
 * grant reviewer needs to assess fund health at a glance.
 *
 * Strictly READ-ONLY. No mutations. Reuses existing DB tables + the cached
 * NAV snapshot stream maintained by sui-community-pool cron.
 *
 * GET /api/platform/risk-overview
 *
 * Returns:
 *   - platform.tvl: total NAV across all products (currently SUI USDC pool)
 *   - platform.drawdownPct: pool share price drawdown from ATH
 *   - platform.peakSharePrice + current
 *   - hedge.totalNotional + totalUnrealizedPnl + count
 *   - hedge.coverageRatio: hedgeNotional / poolNAV
 *   - reconciliation.cronHealth: per-cron staleness summary
 *   - zkAttestations: recent ZK proof commitments (count over last 24h + last 10 feed)
 *   - signals: latest per-asset prediction direction
 *   - asOf
 */
import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/utils/logger';
import { safeErrorResponse } from '@/lib/security/safe-error';
import { readLimiter } from '@/lib/security/rate-limiter';
import { query } from '@/lib/db/postgres';

export const runtime = 'nodejs';
// 30s ISR — matches the underlying NAV cron cadence (30min) and the
// frontend's 60s polling. force-dynamic was neutralising the existing
// Cache-Control header, so every /dashboard load hit the DB. With
// revalidate, N users → 1 DB query per 30s window.
export const revalidate = 30;
export const maxDuration = 15;

interface CronHealth {
  key: string;
  ageMinutes: number;
  status: 'ok' | 'warn' | 'stale';
}

interface HedgeRow {
  market: string;
  side: 'LONG' | 'SHORT';
  notionalUsd: number;
  unrealizedPnlUsd: number;
  leverage: number;
  ageMinutes: number;
}

interface ZkAttestationRow {
  market: string;
  side: string;
  zkProofHash: string;
  createdAt: string;
}

interface RiskOverviewResponse {
  asOf: string;
  platform: {
    tvlUsd: number;
    netCapitalDeposited: number;
    netCapitalReturn: { absoluteUsd: number; percent: number };
    memberCount: number;
    sharePrice: number;
    peakSharePrice: number;
    drawdownPct: number;
    sharePriceReturn: number;
  };
  hedge: {
    activeCount: number;
    totalNotionalUsd: number;
    totalUnrealizedPnlUsd: number;
    coverageRatio: number;
    positions: HedgeRow[];
  };
  reconciliation: {
    cronHealth: CronHealth[];
    healthyCount: number;
    warnCount: number;
    staleCount: number;
  };
  zkAttestations: {
    last24hCount: number;
    recentFeed: ZkAttestationRow[];
  };
  signals: {
    BTC?: { direction: string; confidence: number };
    ETH?: { direction: string; confidence: number };
  };
  agents: {
    cycle: {
      ranAt: string | null;
      ageMinutes: number | null;
      riskScore: number | null;
      riskLevel: string | null;
      summary: string | null;
    };
    directives: Array<{
      asset: string;
      recommendedSide: 'LONG' | 'SHORT' | null;
      confidence: number;
      shouldHedge: boolean;
      reason: string;
    }>;
    scorecard: {
      totalDecisions: number;
      approvedCount: number;
      rejectedCount: number;
      actedOnCount: number;
      settledCount: number;
      netPnlUsd: number;
      winRate: number | null;
    };
  };
  /** v0.3.0 defense stack surface — which gates are ON in prod + drift state. */
  defense: {
    gates: {
      portfolioDriverExecute: boolean;
      staleHedgeAutoClose: boolean;
      alertResponseExecute: boolean;
      alertResponseExecuteHalt: boolean;
      profitLockDisable: boolean;
      suiAutoHedgeDisable: boolean;
    };
    dustFlagsCount: number;
    activeHaltsCount: number;
    integrityDriftCount: number;
    /** Named halts currently in force. Reason is truncated to 120 chars
     *  to keep the response body small; full text lives in cron_state. */
    activeHalts: Array<{ name: string; untilIso: string; reason?: string }>;
    /** Integrity-fsck violation keys currently tripping the drift counter. */
    integrityDriftKeys: string[];
  };
  /** Aggregate incident counts from the alert-log ring buffer — investor-safe
   *  (no raw messages leaked; message text lives at /api/admin/state-snapshot). */
  incidents: {
    last24h: { KILL: number; ERROR: number; WARN: number };
    last7d: { KILL: number; ERROR: number; WARN: number };
    lastKillMinutesAgo: number | null;
    lastKillCategory: 'dust' | 'halt' | 'phantom' | 'deploy-drift' | 'other' | null;
  };
  /** Current allocation percentages per asset from the latest cron snapshot. */
  composition: {
    asOf: string | null;
    byAsset: Record<string, number>;
    unhedgeable: string[]; // assets at 0% due to minQty gap at current NAV
  };
  /** Track record of settled hedges (non-zero PnL only — filters phantoms). */
  hedgeHistory: {
    settledCount: number;
    winCount: number;
    lossCount: number;
    totalPnlUsd: number;
    recent: Array<{
      id: number;
      market: string;
      side: 'LONG' | 'SHORT';
      notionalUsd: number;
      pnlUsd: number;
      closedAt: string;
      durationHours: number;
    }>;
  };
}

const POOL_INCEPTION_SHARE_PRICE = 1.0;

/**
 * Live agent activity surface — what the 7-agent system is recommending
 * right now, plus how well its past recommendations have done. Drives the
 * "AI Agent Activity" panel on /dashboard/risk.
 */
async function getAgentSection(): Promise<RiskOverviewResponse['agents']> {
  const empty = {
    cycle: { ranAt: null, ageMinutes: null, riskScore: null, riskLevel: null, summary: null },
    directives: [] as RiskOverviewResponse['agents']['directives'],
    scorecard: { totalDecisions: 0, approvedCount: 0, rejectedCount: 0, actedOnCount: 0, settledCount: 0, netPnlUsd: 0, winRate: null },
  };
  try {
    const [{ getCronState }, { getLatestDirectives }, { getRecentAgentScorecard }] = await Promise.all([
      import('@/lib/db/cron-state'),
      import('@/lib/services/agents/agent-trade-guard'),
      import('@/lib/db/agent-decisions'),
    ]);
    const [lastCycle, directives, scorecard] = await Promise.all([
      getCronState<{ ts: number; success: boolean; riskScore?: number; riskLevel?: string; leadSummary?: string }>('lead-cycle:last-decision'),
      getLatestDirectives(),
      getRecentAgentScorecard('sui', 7),
    ]);
    const cycleAgeMin = lastCycle?.ts ? Math.floor((Date.now() - lastCycle.ts) / 60_000) : null;
    return {
      cycle: {
        ranAt: lastCycle?.ts ? new Date(lastCycle.ts).toISOString() : null,
        ageMinutes: cycleAgeMin,
        riskScore: lastCycle?.riskScore ?? null,
        riskLevel: lastCycle?.riskLevel ?? null,
        summary: lastCycle?.leadSummary ?? null,
      },
      directives: directives
        ? Object.values(directives.byAsset).map((d) => ({
            asset: d.asset,
            recommendedSide: d.recommendedSide,
            confidence: d.confidence,
            shouldHedge: d.shouldHedge,
            reason: d.reason,
          }))
        : [],
      scorecard,
    };
  } catch (e) {
    logger.warn('[Risk Overview] agent section failed', { error: String(e).slice(0, 200) });
    return empty;
  }
}

/**
 * Read pool's lifetime deposits/withdrawals + ATH directly from the on-chain
 * object via JSON-RPC. Avoids the expensive BlueFin auth path that
 * SuiUsdcPoolService.getPoolStats() triggers.
 */
async function readPoolStaticsOnChain(): Promise<{
  totalDeposited: number; totalWithdrawn: number; allTimeHighSharePrice: number;
} | null> {
  const poolStateId = (
    process.env.NEXT_PUBLIC_SUI_MAINNET_USDC_POOL_STATE ||
    process.env.NEXT_PUBLIC_SUI_MAINNET_COMMUNITY_POOL_STATE ||
    ''
  ).trim();
  if (!poolStateId) return null;
  try {
    // Uses failover transport (2026-07-30) — single-provider clients
    // silently returned $0 when the public fullnode killed JSON-RPC.
    const { createFailoverSuiClient } = await import('@/lib/services/sui/sui-failover-transport');
    const client = createFailoverSuiClient('mainnet');
    const res = await client.getObject({
      id: poolStateId,
      options: { showContent: true },
    });
    const content = res.data?.content as { fields?: Record<string, any> } | null | undefined;
    const fields = content?.fields;
    if (!fields) return null;
    // Decimal handling: USDC has 6 decimals, share price stored in higher precision.
    // On-chain field is all_time_high_nav_per_share (verified against pool state
    // 2026-07-14: value 2318309 = $2.318309). Older code read all_time_high_nav
    // which is undefined — falling back to current share price and reporting
    // drawdownPct=0 even when the pool was 40%+ off ATH.
    return {
      totalDeposited: Number(fields.total_deposited ?? 0) / 1e6,
      totalWithdrawn: Number(fields.total_withdrawn ?? 0) / 1e6,
      allTimeHighSharePrice: Number(fields.all_time_high_nav_per_share ?? 0) / 1e6,
    };
  } catch {
    return null;
  }
}

async function getPoolMetrics() {
  // Primary source: the authoritative DB snapshot written by sui-community-pool
  // cron (source='sui-usdc-pool'). Lifetime totals + ATH come from a direct
  // on-chain RPC read so we don't pay the BlueFin auth cost.
  try {
    const [latest, onChain] = await Promise.all([
      query<{ total_nav: string; share_price: string; member_count: number }>(
        `SELECT total_nav, share_price, member_count FROM community_pool_nav_history
          WHERE chain = 'sui' AND source = 'sui-usdc-pool'
          ORDER BY timestamp DESC LIMIT 1`,
      ),
      readPoolStaticsOnChain(),
    ]);
    const navUsd = Number(latest[0]?.total_nav) || 0;
    const sharePrice = Number(latest[0]?.share_price) || 1;
    const memberCount = Number(latest[0]?.member_count) || 0;
    const peakSharePrice = onChain?.allTimeHighSharePrice && onChain.allTimeHighSharePrice > 0
      ? onChain.allTimeHighSharePrice
      : sharePrice;
    const netCapital = onChain ? onChain.totalDeposited - onChain.totalWithdrawn : 0;
    const drawdownPct = peakSharePrice > 0
      ? Math.max(0, ((peakSharePrice - sharePrice) / peakSharePrice) * 100)
      : 0;
    const sharePriceReturn = ((sharePrice - POOL_INCEPTION_SHARE_PRICE) / POOL_INCEPTION_SHARE_PRICE) * 100;
    return { navUsd, sharePrice, peakSharePrice, drawdownPct, sharePriceReturn, memberCount, netCapital };
  } catch (e: unknown) {
    logger.warn('[risk-overview] pool metrics failed', { error: String(e) });
    return { navUsd: 0, sharePrice: 1, peakSharePrice: 1, drawdownPct: 0, sharePriceReturn: 0, memberCount: 0, netCapital: 0 };
  }
}

async function getActiveHedges(): Promise<HedgeRow[]> {
  try {
    const rows = await query<{
      market: string;
      side: string;
      notional_value: string;
      current_pnl: string;
      leverage: string;
      created_at: Date;
    }>(
      // reconstructed_* orphans are BlueFin positions the reconciler
      // adopted from a venue where our stack lost track of the open —
      // real capital but not something the current strategy manages, so
      // they don't belong in the "active hedges" display. Same filter
      // as the settled-track-record query below (getSettledHedgeHistory).
      `SELECT market, side, notional_value, current_pnl, leverage, created_at
         FROM hedges
        WHERE chain = 'sui'
          AND status = 'active'
          AND market LIKE '%-PERP'
          AND COALESCE(notional_value, 0) >= 1
          AND (order_id IS NULL OR order_id NOT LIKE 'reconstructed_%')
        ORDER BY notional_value DESC
        LIMIT 30`,
    );
    return rows.map((r) => ({
      market: String(r.market),
      side: (String(r.side).toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG') as 'LONG' | 'SHORT',
      notionalUsd: Number(r.notional_value) || 0,
      unrealizedPnlUsd: Number(r.current_pnl) || 0,
      leverage: Number(r.leverage) || 1,
      ageMinutes: Math.round((Date.now() - new Date(r.created_at).getTime()) / 60000),
    }));
  } catch {
    return [];
  }
}

async function getCronHealth(): Promise<CronHealth[]> {
  // The crons that actually move capital or gate risk
  const critical = [
    { key: 'cron:lastRun:sui-community-pool', warnMin: 45, staleMin: 90 },
    { key: 'cron:lastRun:polymarket-edge-trader', warnMin: 12, staleMin: 30 },
    { key: 'cron:lastRun:bluefin-health', warnMin: 12, staleMin: 30 },
    { key: 'cron:lastRun:bluefin-db-reconcile', warnMin: 30, staleMin: 60 },
    { key: 'cron:lastRun:sui-hedge-reconcile', warnMin: 90, staleMin: 180 },
    { key: 'cron:lastRun:pool-nav-monitor', warnMin: 25, staleMin: 60 },
    { key: 'cron:lastRun:hedge-monitor', warnMin: 25, staleMin: 60 },
    { key: 'cron:lastRun:liquidation-guard', warnMin: 20, staleMin: 60 },
    { key: 'cron:lastRun:health-monitor', warnMin: 20, staleMin: 60 },
  ];

  try {
    const rows = await query<{ key: string; value: string }>(
      `SELECT key, value FROM cron_state WHERE key = ANY($1::text[])`,
      [critical.map((c) => c.key)],
    );
    const byKey = new Map(rows.map((r) => [r.key, Number(r.value)]));
    const now = Date.now();
    return critical.map(({ key, warnMin, staleMin }) => {
      const ts = byKey.get(key);
      if (!ts) {
        return { key: key.replace('cron:lastRun:', ''), ageMinutes: Infinity, status: 'stale' };
      }
      const ageMinutes = (now - ts) / 60000;
      const status: 'ok' | 'warn' | 'stale' =
        ageMinutes > staleMin ? 'stale' : ageMinutes > warnMin ? 'warn' : 'ok';
      return { key: key.replace('cron:lastRun:', ''), ageMinutes: Math.round(ageMinutes * 10) / 10, status };
    });
  } catch {
    return [];
  }
}

async function getZkAttestations(): Promise<{ last24hCount: number; recentFeed: ZkAttestationRow[] }> {
  try {
    const [countRow, recent] = await Promise.all([
      query<{ c: string }>(
        `SELECT COUNT(*)::text as c
           FROM hedges
          WHERE zk_proof_hash IS NOT NULL
            AND zk_proof_hash != ''
            AND created_at > NOW() - INTERVAL '24 hours'`,
      ),
      query<{ market: string; side: string; zk_proof_hash: string; created_at: Date }>(
        `SELECT market, side, zk_proof_hash, created_at
           FROM hedges
          WHERE zk_proof_hash IS NOT NULL
            AND zk_proof_hash != ''
          ORDER BY created_at DESC LIMIT 10`,
      ),
    ]);
    return {
      last24hCount: Number(countRow[0]?.c) || 0,
      recentFeed: recent.map((r) => ({
        market: String(r.market),
        side: String(r.side),
        zkProofHash: String(r.zk_proof_hash).slice(0, 16) + '…',
        createdAt: new Date(r.created_at).toISOString(),
      })),
    };
  } catch {
    return { last24hCount: 0, recentFeed: [] };
  }
}

/**
 * v0.3.0 defense stack surface — currently-active gate footprint + any
 * detected drift. Reads envFlag() (same source of truth as the safety
 * modules themselves) and the cron_state prefixes that the state-
 * integrity fsck uses. Zero side-effects.
 */
async function getDefenseSection(): Promise<RiskOverviewResponse['defense']> {
  const empty: RiskOverviewResponse['defense'] = {
    gates: {
      portfolioDriverExecute: false, staleHedgeAutoClose: false,
      alertResponseExecute: false, alertResponseExecuteHalt: false,
      profitLockDisable: false, suiAutoHedgeDisable: false,
    },
    dustFlagsCount: 0, activeHaltsCount: 0, integrityDriftCount: 0,
    activeHalts: [], integrityDriftKeys: [],
  };
  try {
    const [{ envFlag, envFlagOnByDefault }, { getCronStateByPrefix }, { getActiveHedges }, { findIntegrityViolations }] = await Promise.all([
      import('@/lib/utils/env-flag'),
      import('@/lib/db/cron-state'),
      import('@/lib/db/hedges'),
      import('@/lib/services/state-integrity/checks'),
    ]);
    const [halts, haltReasons, directives, peaks, dustFlags, activeHedges] = await Promise.all([
      getCronStateByPrefix('cron:haltUntil:'),
      getCronStateByPrefix('cron:haltReason:'),
      getCronStateByPrefix('alert-response:'),
      getCronStateByPrefix('poolNav:peak:'),
      getCronStateByPrefix('stale-dust-flag:'),
      getActiveHedges(undefined, 'sui').catch(() => []),
    ]);
    const now = Date.now();
    const activeHaltEntries = [...halts.entries()].filter(([, v]) => Number(v) > now);
    const activeHalts = activeHaltEntries.map(([key, until]) => {
      // key shape: cron:haltUntil:<scope> — derive matching reason key
      const scope = key.replace(/^cron:haltUntil:/, '');
      const reasonRaw = haltReasons.get(`cron:haltReason:${scope}`);
      const reason = reasonRaw ? String(reasonRaw).replace(/^"|"$/g, '').slice(0, 120) : undefined;
      return { name: scope, untilIso: new Date(Number(until)).toISOString(), reason };
    });
    const activeIds = new Set<number | string>(activeHedges.map((h) => h.id));
    const entries = [
      ...[...halts.entries()].map(([key, value]) => ({ key, value })),
      ...[...directives.entries()].map(([key, value]) => ({ key, value })),
      ...[...peaks.entries()].map(([key, value]) => ({ key, value })),
      ...[...dustFlags.entries()].map(([key, value]) => ({ key, value })),
    ];
    const violations = findIntegrityViolations(entries, activeIds, now);
    return {
      gates: {
        portfolioDriverExecute: envFlagOnByDefault('PORTFOLIO_DRIVER_EXECUTE'),
        staleHedgeAutoClose: envFlagOnByDefault('STALE_HEDGE_AUTO_CLOSE'),
        alertResponseExecute: envFlagOnByDefault('ALERT_RESPONSE_EXECUTE'),
        alertResponseExecuteHalt: envFlag('ALERT_RESPONSE_EXECUTE_HALT'),
        profitLockDisable: envFlag('PROFIT_LOCK_DISABLE'),
        suiAutoHedgeDisable: envFlag('SUI_AUTO_HEDGE_DISABLE'),
      },
      dustFlagsCount: dustFlags.size,
      activeHaltsCount: activeHalts.length,
      integrityDriftCount: violations.length,
      activeHalts,
      integrityDriftKeys: violations.slice(0, 20).map((v) => `${v.category}:${v.key}`),
    };
  } catch (e) {
    logger.warn('[Risk Overview] defense section failed', { error: String(e).slice(0, 200) });
    return empty;
  }
}

/**
 * Aggregate incident counts — reads the alert-log ring buffer and rolls
 * up KILL/ERROR/WARN counts by window. Never leaks raw messages here
 * (they can contain wallet addresses, error text, internal state). Full
 * detail lives at /api/admin/state-snapshot (CRON_SECRET gated).
 */
async function getIncidentsSection(): Promise<RiskOverviewResponse['incidents']> {
  const empty: RiskOverviewResponse['incidents'] = {
    last24h: { KILL: 0, ERROR: 0, WARN: 0 },
    last7d: { KILL: 0, ERROR: 0, WARN: 0 },
    lastKillMinutesAgo: null,
    lastKillCategory: null,
  };
  try {
    const { getCronState } = await import('@/lib/db/cron-state');
    const buffer = await getCronState<Array<{ at: number; level: string; message?: string }>>('alert-log:ring-buffer');
    if (!Array.isArray(buffer)) return empty;
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const last24h = { KILL: 0, ERROR: 0, WARN: 0 };
    const last7d = { KILL: 0, ERROR: 0, WARN: 0 };
    let lastKill: { at: number; msg: string } | null = null;
    for (const e of buffer) {
      const age = now - e.at;
      const bucket = ['KILL', 'ERROR', 'WARN'].includes(e.level) ? (e.level as keyof typeof last24h) : null;
      if (!bucket) continue;
      if (age < 7 * day) last7d[bucket]++;
      if (age < day) last24h[bucket]++;
      if (bucket === 'KILL' && (!lastKill || e.at > lastKill.at)) {
        lastKill = { at: e.at, msg: e.message || '' };
      }
    }
    let lastKillCategory: RiskOverviewResponse['incidents']['lastKillCategory'] = null;
    if (lastKill) {
      const m = lastKill.msg.toLowerCase();
      if (m.includes('dust-locked') || m.includes('dust_locked')) lastKillCategory = 'dust';
      else if (m.includes('halt')) lastKillCategory = 'halt';
      else if (m.includes('phantom')) lastKillCategory = 'phantom';
      else if (m.includes('deploy') || m.includes('drift')) lastKillCategory = 'deploy-drift';
      else lastKillCategory = 'other';
    }
    return {
      last24h, last7d,
      lastKillMinutesAgo: lastKill ? Math.round((now - lastKill.at) / 60_000) : null,
      lastKillCategory,
    };
  } catch (e) {
    logger.warn('[Risk Overview] incidents section failed', { error: String(e).slice(0, 200) });
    return empty;
  }
}

/**
 * Latest pool composition — reads the `allocations` JSONB from the most
 * recent nav_history snapshot. Also flags any asset at 0% (dropped by
 * the hedgeability spot-cap because current NAV can't afford the
 * asset's minQty perp hedge). Tells the "why is BTC 0%" story without
 * making the operator explain it.
 */
async function getCompositionSection(): Promise<RiskOverviewResponse['composition']> {
  const empty: RiskOverviewResponse['composition'] = { asOf: null, byAsset: {}, unhedgeable: [] };
  try {
    const rows = await query<{ timestamp: Date; allocations: Record<string, number> | null }>(
      `SELECT timestamp, allocations FROM community_pool_nav_history
        WHERE chain='sui' AND source='sui-usdc-pool' AND allocations IS NOT NULL
        ORDER BY timestamp DESC LIMIT 1`,
    );
    const latest = rows[0];
    if (!latest || !latest.allocations) return empty;
    const byAsset: Record<string, number> = {};
    for (const [k, v] of Object.entries(latest.allocations)) {
      const n = Number(v);
      if (Number.isFinite(n)) byAsset[k.toUpperCase()] = Math.round(n * 100) / 100;
    }
    // Assets at 0% that aren't USDC → hedgeability-clamped (BTC/ETH/SUI
    // where NAV × alloc < 1.5 × minQty notional). USDC at 0 is not
    // "unhedgeable"; it's just no reserve.
    const unhedgeable = Object.entries(byAsset)
      .filter(([k, v]) => v === 0 && k !== 'USDC' && ['BTC', 'ETH', 'SUI'].includes(k))
      .map(([k]) => k);
    return { asOf: latest.timestamp.toISOString(), byAsset, unhedgeable };
  } catch (e) {
    logger.warn('[Risk Overview] composition section failed', { error: String(e).slice(0, 200) });
    return empty;
  }
}

/**
 * Track record of SETTLED hedges — those with non-zero PnL. The DB has
 * 200+ closed rows total but ~190 are reconciler-adopted / phantom
 * closes (current_pnl = realized_pnl = 0) that would drown the actual
 * trading track record. Filtering to non-zero PnL shows the honest
 * ~45% win rate at break-even on 22 real closes.
 */
async function getHedgeHistorySection(): Promise<RiskOverviewResponse['hedgeHistory']> {
  const empty: RiskOverviewResponse['hedgeHistory'] = {
    settledCount: 0, winCount: 0, lossCount: 0, totalPnlUsd: 0, recent: [],
  };
  try {
    const [aggRows, recentRows] = await Promise.all([
      query<{ total: number; wins: number; losses: number; pnl_sum: number }>(
        `SELECT
           COUNT(*)::int as total,
           COUNT(*) FILTER (WHERE current_pnl::float > 0)::int as wins,
           COUNT(*) FILTER (WHERE current_pnl::float < 0)::int as losses,
           COALESCE(SUM(current_pnl::float), 0)::float as pnl_sum
         FROM hedges
         WHERE chain='sui' AND status='closed'
           AND notional_value::float >= 1
           AND current_pnl::float != 0`,
      ),
      query<{ id: number; market: string; side: string; notional: number; pnl: number; closed_at: Date; duration_hours: number }>(
        `SELECT id, market, side,
           notional_value::float as notional,
           current_pnl::float as pnl,
           closed_at,
           EXTRACT(EPOCH FROM (closed_at - created_at))/3600 as duration_hours
         FROM hedges
         WHERE chain='sui' AND status='closed'
           AND notional_value::float >= 1
           AND current_pnl::float != 0
           AND closed_at IS NOT NULL
         ORDER BY closed_at DESC LIMIT 10`,
      ),
    ]);
    const agg = aggRows[0] ?? { total: 0, wins: 0, losses: 0, pnl_sum: 0 };
    return {
      settledCount: agg.total,
      winCount: agg.wins,
      lossCount: agg.losses,
      totalPnlUsd: Math.round((agg.pnl_sum || 0) * 100) / 100,
      recent: recentRows.map((r) => ({
        id: r.id,
        market: r.market,
        side: (r.side || '').toUpperCase() as 'LONG' | 'SHORT',
        notionalUsd: Math.round(r.notional * 100) / 100,
        pnlUsd: Math.round(r.pnl * 100) / 100,
        closedAt: r.closed_at.toISOString(),
        durationHours: Math.round((r.duration_hours || 0) * 10) / 10,
      })),
    };
  } catch (e) {
    logger.warn('[Risk Overview] hedge history failed', { error: String(e).slice(0, 200) });
    return empty;
  }
}

async function getLatestSignals(): Promise<RiskOverviewResponse['signals']> {
  try {
    // The aggregator returns one fused cross-asset prediction; BTC and ETH
    // share it for the dashboard summary (per-asset breakdown lives at
    // /api/predictions/per-asset for users who want the deeper view).
    const { PredictionAggregatorService } = await import(
      '@/lib/services/market-data/PredictionAggregatorService'
    );
    const p = await PredictionAggregatorService.getAggregatedPrediction();
    if (!p) return {};
    const direction = String(p.direction || 'NEUTRAL');
    const confidence = Math.round(Number(p.confidence) || 0);
    return {
      BTC: { direction, confidence },
      ETH: { direction, confidence },
    };
  } catch {
    return {};
  }
}

export async function GET(request: NextRequest): Promise<NextResponse<RiskOverviewResponse | { error: string }>> {
  const limited = readLimiter.check(request);
  if (limited) return limited as NextResponse<RiskOverviewResponse | { error: string }>;

  try {
    const [pool, hedges, cronHealth, zkAttestations, signals, defense, incidents, composition, hedgeHistory] = await Promise.all([
      getPoolMetrics(),
      getActiveHedges(),
      getCronHealth(),
      getZkAttestations(),
      getLatestSignals(),
      getDefenseSection(),
      getIncidentsSection(),
      getCompositionSection(),
      getHedgeHistorySection(),
    ]);
    const netCapital = pool.netCapital;

    const totalHedgeNotional = hedges.reduce((s, h) => s + h.notionalUsd, 0);
    const totalHedgePnl = hedges.reduce((s, h) => s + h.unrealizedPnlUsd, 0);

    const response: RiskOverviewResponse = {
      asOf: new Date().toISOString(),
      platform: {
        tvlUsd: pool.navUsd,
        netCapitalDeposited: netCapital,
        netCapitalReturn: {
          absoluteUsd: pool.navUsd - netCapital,
          percent: netCapital > 0 ? ((pool.navUsd - netCapital) / netCapital) * 100 : 0,
        },
        memberCount: pool.memberCount,
        sharePrice: pool.sharePrice,
        peakSharePrice: pool.peakSharePrice,
        drawdownPct: pool.drawdownPct,
        sharePriceReturn: pool.sharePriceReturn,
      },
      hedge: {
        activeCount: hedges.length,
        totalNotionalUsd: totalHedgeNotional,
        totalUnrealizedPnlUsd: totalHedgePnl,
        coverageRatio: pool.navUsd > 0 ? totalHedgeNotional / pool.navUsd : 0,
        positions: hedges,
      },
      reconciliation: {
        cronHealth,
        healthyCount: cronHealth.filter((c) => c.status === 'ok').length,
        warnCount: cronHealth.filter((c) => c.status === 'warn').length,
        staleCount: cronHealth.filter((c) => c.status === 'stale').length,
      },
      zkAttestations,
      signals,
      agents: await getAgentSection(),
      defense,
      incidents,
      composition,
      hedgeHistory,
    };

    return NextResponse.json(response, {
      // Investor-facing aggregation; underlying cron writes NAV every
      // 30min. 30s edge cache is comfortable for LP dashboards.
      headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' },
    });
  } catch (error: unknown) {
    return safeErrorResponse(error, 'Platform risk overview') as NextResponse<RiskOverviewResponse | { error: string }>;
  }
}
