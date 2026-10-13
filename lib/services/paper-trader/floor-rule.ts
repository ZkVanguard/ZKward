/**
 * The floor rule — how much of a book to hold in the coins, with no forecast.
 *
 * Exposure is a multiple of the cushion: what the book is worth above its
 * floor. The floor is a share of the book's highest value so far. When prices
 * rise the book grows, the cushion grows and exposure follows it up; when
 * they fall exposure is sold down, so the book approaches its floor instead
 * of falling through it. What the rule protects is that share of the peak,
 * not the starting value.
 *
 * Pure: the book (FloorTrader) and its replay run these same functions.
 */

export interface FloorRule {
  /** Dollars of exposure per dollar of cushion. */
  multiplier: number;
  /** The floor, as a share of the book's highest value so far. */
  floorShare: number;
  /** Exposure moves in whole lots of this size, and each asset always keeps one. */
  lotUsd: number;
  /** Most lots one asset may trade in one tick, so a large move is worked over a few ticks. */
  maxLotsPerTick: number;
}

// Fixed for the length of the test: the replay that justified the book ran these values.
export const FLOOR_RULE: FloorRule = {
  multiplier: 3,
  floorShare: 0.9,
  lotUsd: 1_000,
  maxLotsPerTick: 5,
};

/** Dollars of exposure the rule wants for a book worth `valueUsd` whose highest value so far is `peakUsd`. */
export function floorTargetUsd(valueUsd: number, peakUsd: number, rule: FloorRule = FLOOR_RULE): number {
  if (!(valueUsd > 0)) return 0;
  const cushion = valueUsd - rule.floorShare * peakUsd;
  return Math.min(Math.max(rule.multiplier * cushion, 0), valueUsd);
}

export interface FloorPlan {
  /** The peak after this reading: the floor never moves down. */
  peakUsd: number;
  floorUsd: number;
  targetUsd: number;
  /** Whole lots to buy (positive) or sell (negative), per asset. */
  lots: Record<string, number>;
}

/**
 * What to trade now. The target is split equally across the assets, and an
 * asset trades only in whole lots toward its share: inside one lot nothing
 * happens, which is the band that keeps a quiet market from churning the book.
 */
export function planFloorRebalance(args: {
  valueUsd: number;
  peakUsd: number;
  heldUsd: Record<string, number>;
  assets: readonly string[];
  rule?: FloorRule;
}): FloorPlan {
  const rule = args.rule ?? FLOOR_RULE;
  const peakUsd = Math.max(args.peakUsd, args.valueUsd);
  const targetUsd = floorTargetUsd(args.valueUsd, peakUsd, rule);
  // A book at its floor would hold nothing, and a book that holds nothing can
  // never earn its cushion back: the floor would be a block with no way out.
  // One lot per asset is the way out, small enough that the floor gives by
  // only a fraction of any further fall.
  const perAsset = Math.max(targetUsd / args.assets.length, rule.lotUsd);
  const lots: Record<string, number> = {};
  for (const asset of args.assets) {
    const wanted = Math.trunc((perAsset - (args.heldUsd[asset] ?? 0)) / rule.lotUsd);
    lots[asset] = Math.max(-rule.maxLotsPerTick, Math.min(rule.maxLotsPerTick, wanted)) || 0;
  }
  return { peakUsd, floorUsd: rule.floorShare * peakUsd, targetUsd, lots };
}
