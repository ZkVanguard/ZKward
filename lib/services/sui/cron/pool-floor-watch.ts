/**
 * The floor rule on the live pool, watch-only.
 *
 * Every pool run works out what the floor rule (paper book -8, floor-rule.ts)
 * would hold for the real pool: its value, its own peak, the floor at 90 % of
 * that peak, and the exposure per coin. It also says whether that exposure is
 * tradable at the venue's smallest order, and from what pool size it would be.
 *
 * It places no order and changes no position: the only thing it writes is the
 * pool's peak, so the floor can ratchet. Going live is a separate decision
 * (docs/_ops/TODO_POOL_FLOOR_STRATEGY_2026-10-19.md, phase 4).
 */
import { getCronStateStrict, setCronState } from '@/lib/db/cron-state';
import { floorTargetUsd, FLOOR_RULE } from '@/lib/services/paper-trader/floor-rule';
import { ASSET_MIN_QTY } from '@/lib/config/trader-assets';

export const WATCH_ASSETS = ['BTC', 'ETH'] as const;
type WatchAsset = (typeof WATCH_ASSETS)[number];
const KEY_PEAK = 'pool-floor-watch:peak';

export interface PoolFloorWatch {
  valueUsd: number;
  /** The pool's highest value since the watch began; the floor never moves down. */
  peakUsd: number;
  floorUsd: number;
  /** Exposure the rule wants, all coins together. */
  targetUsd: number;
  perAsset: Record<WatchAsset, { targetUsd: number; minOrderUsd: number; tradable: boolean }>;
  /** True only when every coin's target reaches the venue's smallest order. */
  tradable: boolean;
  /** Pool value at its peak from which every coin's target reaches the venue's smallest order. */
  minPoolUsd: number;
}

/** Pure: the plan for a pool worth `valueUsd`, whose peak so far is `peakUsd`, at `prices`. */
export function planPoolFloor(valueUsd: number, peakUsd: number, prices: Record<string, number>): PoolFloorWatch {
  const peak = Math.max(peakUsd, valueUsd);
  const targetUsd = floorTargetUsd(valueUsd, peak);
  // At its peak the cushion is (1 - floorShare) of the pool, so each coin's share of the target is this much of it.
  const shareAtPeak = (FLOOR_RULE.multiplier * (1 - FLOOR_RULE.floorShare)) / WATCH_ASSETS.length;
  const perAsset = {} as PoolFloorWatch['perAsset'];
  let minPoolUsd = 0;
  for (const asset of WATCH_ASSETS) {
    const minOrderUsd = ASSET_MIN_QTY[asset] * (prices[asset] ?? NaN);
    const target = targetUsd / WATCH_ASSETS.length;
    perAsset[asset] = { targetUsd: target, minOrderUsd, tradable: Number.isFinite(minOrderUsd) && target >= minOrderUsd };
    minPoolUsd = Math.max(minPoolUsd, minOrderUsd / shareAtPeak);
  }
  return {
    valueUsd,
    peakUsd: peak,
    floorUsd: FLOOR_RULE.floorShare * peak,
    targetUsd,
    perAsset,
    tradable: WATCH_ASSETS.every((a) => perAsset[a].tradable),
    minPoolUsd,
  };
}

/** One watch reading for the pool. Null when the pool's value or a price is not known this run. */
export async function runPoolFloorWatch(args: { navUsd: number; pricesUSD: Record<string, number> }): Promise<PoolFloorWatch | null> {
  if (!(args.navUsd > 0) || WATCH_ASSETS.some((a) => !(args.pricesUSD[a] > 0))) return null;
  const stored = Number((await getCronStateStrict<number>(KEY_PEAK)) ?? 0);
  const plan = planPoolFloor(args.navUsd, stored, args.pricesUSD);
  if (plan.peakUsd > stored) await setCronState(KEY_PEAK, plan.peakUsd);
  return plan;
}
