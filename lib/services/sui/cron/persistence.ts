/**
 * SUI community-pool cron — DB persistence steps (extracted from the route).
 *
 * Steps 4 (NAV snapshot), 5 (member sync), 6 (pool state) were inline in
 * app/api/cron/sui-community-pool/route.ts. Each is non-critical: it logs and
 * swallows its own error so one failing write never skips the others — that
 * independent-failure semantics is preserved exactly here.
 *
 * Pure relocation; no behavior change. The navUsd / sharePriceUsd / safety-
 * ceiling computation stays in the route because later steps depend on it.
 */
import { recordNavSnapshot, saveUserSharesToDb, savePoolStateToDb, getNavHistory } from '@/lib/db/community-pool';
import { logger } from '@/lib/utils/logger';

// Maximum allowed NAV move between two consecutive 30-min cron ticks. A
// stable USDC-heavy pool cannot legitimately swing more than ~2% per tick;
// observed jitter has been 4–6% (BlueFin uPnL/collateral read racing). We
// clamp at 3.5% — permissive enough for real market moves in a single
// tick, tight enough to absorb the oscillation.
export const MAX_NAV_STEP_PCT = 3.5;
// Median window for outlier detection. Odd number so the median is a
// single sample. 3 gives us "typical of the last 90 min".
export const MEDIAN_WINDOW = 3;

export interface StabilizerResult {
  publishedNav: number;
  publishedSharePrice: number;
  stabilized: boolean;
  clampedFromRaw: number;
  median: number | null;
}

/**
 * Pure clamp math — takes raw NAV + trailing history + shares and returns
 * the stabilized result. Separated from `stabilizeNav()` so it's unit-
 * testable without touching the DB. Behavior is locked by
 * test/unit/nav-stabilizer.test.ts.
 *
 * The `history` argument should be the most-recent NAV samples in
 * chronological order (oldest → newest). Only the last `MEDIAN_WINDOW`
 * are consulted. When fewer than one usable sample is present, the raw
 * value passes through unchanged.
 */
export function clampNavAgainstMedian(
  rawNavUsd: number,
  totalShares: number,
  history: number[],
): StabilizerResult {
  const shares = Math.max(totalShares, 1e-9);
  const recent = history.slice(-MEDIAN_WINDOW).filter(Number.isFinite);
  if (recent.length === 0) {
    return {
      publishedNav: rawNavUsd,
      publishedSharePrice: rawNavUsd / shares,
      stabilized: false,
      clampedFromRaw: 0,
      median: null,
    };
  }
  const sorted = [...recent].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const deltaPct = median > 0 ? ((rawNavUsd - median) / median) * 100 : 0;
  if (Math.abs(deltaPct) <= MAX_NAV_STEP_PCT) {
    return {
      publishedNav: rawNavUsd,
      publishedSharePrice: rawNavUsd / shares,
      stabilized: false,
      clampedFromRaw: 0,
      median,
    };
  }
  const capped = deltaPct > 0
    ? median * (1 + MAX_NAV_STEP_PCT / 100)
    : median * (1 - MAX_NAV_STEP_PCT / 100);
  return {
    publishedNav: capped,
    publishedSharePrice: capped / shares,
    stabilized: true,
    clampedFromRaw: rawNavUsd - capped,
    median,
  };
}

/**
 * I/O wrapper around `clampNavAgainstMedian`. Fetches the last 24h of
 * chain-scoped NAV history from the DB and delegates to the pure clamp.
 *
 * On DB failure passes the raw value through with `stabilized: false`
 * — stabilization must never *cause* an outage.
 */
async function stabilizeNav(
  rawNavUsd: number,
  totalShares: number,
  chain: string,
): Promise<StabilizerResult> {
  try {
    const hist = await getNavHistory(1, chain);
    return clampNavAgainstMedian(
      rawNavUsd,
      totalShares,
      hist.map(s => Number(s.total_nav)),
    );
  } catch (err) {
    logger.warn('[SUI Cron] NAV stabilizer failed, passing raw through', { error: err });
    const shares = Math.max(totalShares, 1e-9);
    return { publishedNav: rawNavUsd, publishedSharePrice: rawNavUsd / shares, stabilized: false, clampedFromRaw: 0, median: null };
  }
}

const POOL_ASSETS = ['BTC', 'ETH', 'SUI'] as const;

interface PoolStatsLike {
  totalNAV: number;
  totalShares: number;
  sharePrice: number;
  memberCount: number;
}

interface PoolMemberLike {
  address: string;
  shares: number;
  depositedSui: number;
  withdrawnSui: number;
}

/**
 * A member's cost basis is the capital they still have in the pool: what the
 * contract recorded as deposited less what it recorded as withdrawn. The
 * position's current value is not a cost: writing it made every member read as
 * break-even whatever the share price had done.
 */
export function memberCostBasisUsd(m: Pick<PoolMemberLike, 'depositedSui' | 'withdrawnSui'>): number {
  return Math.max(0, m.depositedSui - m.withdrawnSui);
}

interface MemberSource {
  getAllMembers(): Promise<PoolMemberLike[]>;
}

/** Step 4 (write): record a NAV snapshot. Non-critical. */
export async function recordPoolNavSnapshot(args: {
  sharePriceUsd: number;
  navUsd: number;
  poolStats: PoolStatsLike;
  allocations: Record<string, number>;
}): Promise<void> {
  const { sharePriceUsd, navUsd, poolStats, allocations } = args;
  try {
    const rawNav = navUsd || poolStats.totalNAV;
    const rawSharePrice = sharePriceUsd || poolStats.sharePrice;

    // Step-clamp against the trailing median. Rejects the 4–6% "jitter"
    // spikes we've observed from racing BlueFin uPnL reads without
    // affecting real market moves (which catch up over multiple ticks).
    const stab = await stabilizeNav(rawNav, poolStats.totalShares, 'sui');
    const finalNav = stab.publishedNav;
    const finalSharePrice = stab.publishedSharePrice || rawSharePrice;

    if (stab.stabilized) {
      logger.warn('[SUI Cron] NAV clamped by stabilizer', {
        raw: rawNav.toFixed(4),
        published: finalNav.toFixed(4),
        clampedDelta: stab.clampedFromRaw.toFixed(4),
        median: stab.median?.toFixed(4),
        deltaPct: (((rawNav - (stab.median || rawNav)) / (stab.median || rawNav)) * 100).toFixed(2) + '%',
      });
    }

    await recordNavSnapshot({
      sharePrice: finalSharePrice,
      totalNav: finalNav,
      totalShares: poolStats.totalShares,
      memberCount: poolStats.memberCount,
      allocations,
      source: stab.stabilized ? 'sui-usdc-pool:clamped' : 'sui-usdc-pool',
      chain: 'sui',
    });
    logger.info('[SUI Cron] NAV snapshot recorded', {
      nav: finalNav.toFixed(4),
      sharePrice: finalSharePrice.toFixed(6),
      stabilized: stab.stabilized,
    });
  } catch (navErr) {
    logger.warn('[SUI Cron] Failed to record NAV (non-critical)', { error: navErr });
  }
}

/** Step 5: sync on-chain members to DB. Non-critical. */
export async function syncMembersToDb(args: {
  suiService: MemberSource;
}): Promise<void> {
  const { suiService } = args;
  try {
    const members = await suiService.getAllMembers();
    let synced = 0;
    for (const m of members) {
      if (m.shares > 0) {
        await saveUserSharesToDb({
          walletAddress: m.address.toLowerCase(),
          shares: m.shares,
          costBasisUSD: memberCostBasisUsd(m),
          chain: 'sui',
        });
        synced++;
      }
    }
    logger.info('[SUI Cron] Members synced to DB', { synced, total: members.length });
  } catch (syncErr) {
    logger.warn('[SUI Cron] Member sync failed (non-critical)', { error: syncErr });
  }
}

/** Step 6: persist pool state + last AI decision. Non-critical. */
export async function savePoolState(args: {
  navUsd: number;
  sharePriceUsd: number;
  poolStats: PoolStatsLike;
  allocations: Record<string, number>;
  reasoning: string;
  pricesUSD: Record<string, number>;
}): Promise<void> {
  const { navUsd, sharePriceUsd, poolStats, allocations, reasoning, pricesUSD } = args;
  try {
    const poolAllocRecord: Record<string, { percentage: number; valueUSD: number; amount: number; price: number }> = {};
    for (const asset of POOL_ASSETS) {
      const pct = allocations[asset] || 25;
      poolAllocRecord[asset] = {
        percentage: pct,
        valueUSD: navUsd * (pct / 100),
        amount: 0,
        price: pricesUSD[asset] || 0,
      };
    }

    await savePoolStateToDb({
      totalValueUSD: navUsd,
      totalShares: poolStats.totalShares,
      sharePrice: sharePriceUsd || 1,
      allocations: poolAllocRecord,
      lastRebalance: Date.now(),
      lastAIDecision: {
        timestamp: Date.now(),
        reasoning,
        allocations,
      },
      chain: 'sui',
    });
    logger.info('[SUI Cron] Pool state saved to DB');
  } catch (dbErr) {
    logger.warn('[SUI Cron] DB pool state save failed (non-critical)', { error: dbErr });
  }
}
