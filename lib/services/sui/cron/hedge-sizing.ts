/**
 * Pure hedge-sizing math for the SUI community-pool auto-hedge step.
 *
 * Extracted verbatim from app/api/cron/sui-community-pool/route.ts so the
 * leverage / hedge-ratio / margin / reserve formulas have a single source of
 * truth and a test net (test/unit/hedge-sizing.test.ts). No I/O — every fn is
 * a pure function of NAV / allocation / price, safe to unit-test without the
 * live DB or signing keys.
 *
 * NAV-tiered leverage caps single-wallet liquidation risk as the pool grows:
 * tiny pools may use up to 10x to clear BlueFin minQty; large pools cap at 2x.
 */
export type NavTier = 'tiny' | 'small' | 'medium' | 'large';

export function navTier(navUsd: number): NavTier {
  if (navUsd < 1_000) return 'tiny';
  if (navUsd < 1_000_000) return 'small';
  if (navUsd < 100_000_000) return 'medium';
  return 'large';
}

export function tierLeverageCap(tier: NavTier): number {
  switch (tier) {
    case 'tiny': return 5;
    case 'small': return 3;
    case 'medium': return 3;
    case 'large': return 2;
  }
}

/**
 * Effective leverage = the tier cap, optionally lowered (never raised) by an
 * operator's configured maxLeverage. Mirrors `Math.min(cfg || cap, cap)`.
 */
export function resolveLeverage(navUsd: number, maxLeverageConfig?: number): number {
  const cap = tierLeverageCap(navTier(navUsd));
  return Math.min(maxLeverageConfig || cap, cap);
}

/** Hedge ratio: tiny pools (<$1k) fully hedge; larger pools hedge 50%. */
export function hedgeRatioForNav(navUsd: number): number {
  return navUsd < 1000 ? 1.0 : 0.5;
}

/**
 * Target BlueFin margin to deposit = notional / leverage, floored at $1.5
 * (BlueFin min deposit 1 USDC + buffer). notional = NAV × allocPct × ratio.
 */
export function computeTargetMargin(
  navUsd: number,
  totalAllocPct: number,
  hedgeRatio: number,
  leverage: number,
): number {
  return Math.max(
    1.5,
    (navUsd * (totalAllocPct / 100) * hedgeRatio) / Math.max(1, leverage) + 0.5,
  );
}

/** Per-asset hedge notional in USD. */
export function hedgeValueUsd(navUsd: number, allocationPct: number, hedgeRatio: number): number {
  return navUsd * (allocationPct / 100) * hedgeRatio;
}

/**
 * Perp size in base units for that notional: notional ÷ price.
 *
 * Leverage is not in this formula. It decides how much margin backs the
 * position (computeTargetMargin: notional ÷ leverage), not how large the
 * position is. Until 2026-10 the size was notional × leverage ÷ price: at 5x a
 * bearish allocation was shorted at five times the spot it was meant to
 * offset, leaving the pool net short four times that allocation, while the
 * margin target and the recorded notional both assumed the unlevered size.
 */
export function hedgeSizeBase(navUsd: number, allocationPct: number, hedgeRatio: number, price: number): number {
  return price > 0 ? hedgeValueUsd(navUsd, allocationPct, hedgeRatio) / price : 0;
}

/**
 * NAV-scaled reserves/caps so the same code works for $50 testnet pools and
 * $100M production pools. `suiPriceUsd` is the (already non-zero) SUI price;
 * callers pass `Math.max(0.01, pricesUSD.SUI || 1)`.
 *   • spotReserve: 0.05% of NAV (min $0.50, max $5k)
 *   • suiReserve:  0.001% of NAV in SUI (min 0.5 SUI)
 *   • maxSwapSui:  0.1% of NAV per tick in SUI (min 5 SUI)
 */
export function scaledReserves(navUsd: number, suiPriceUsd: number): {
  spotReserve: number;
  suiReserve: number;
  maxSwapSui: number;
} {
  const suiPrice = Math.max(0.01, suiPriceUsd || 1);
  return {
    spotReserve: Math.min(5_000, Math.max(0.5, navUsd * 0.0005)),
    suiReserve: Math.max(0.5, (navUsd * 0.00001) / suiPrice),
    maxSwapSui: Math.max(5, (navUsd * 0.001) / suiPrice),
  };
}
