/**
 * Per-symbol perp-hedgeability clamp.
 *
 * BlueFin enforces per-symbol minQty: BTC-PERP 0.001 (~$73 notional),
 * ETH-PERP 0.01 (~$30), SUI-PERP 1 (~$4). When NAV × allocation% × ratio
 * can't clear an asset's minQty, the perp leg of
 * that asset is unhedgeable on the current cycle — opening only the
 * spot leg leaves the pool naked-long that asset even when the AI
 * sentiment is BEARISH and the cron tries to short.
 *
 * Fix: before swap + hedge, zero the allocation for unhedgeable assets
 * and redistribute their share proportionally to the hedgeable ones.
 * Two effects:
 *   1. Step 7 (rebalance swaps) doesn't acquire spot exposure we can't
 *      neutralize.
 *   2. Step 8 (auto-hedge) only fires for assets that will actually fill.
 *
 * Pure function — no I/O. Returns the adjusted allocations + a report of
 * which assets were dropped + why.
 */
import { hedgeSizeBase } from '@/lib/services/sui/cron/hedge-sizing';
import { snapToStepSize } from '@/lib/services/sui/bluefin-order-size';

/**
 * The open path refuses a position under 1.5x the minimum quantity (it would
 * turn into unclosable dust). The clamp must refuse the same sizes, or it
 * keeps an allocation whose spot leg is bought and whose hedge is then
 * skipped. Same value as OPEN_MIN_QTY_BUFFER in dust-manager.ts.
 */
export const HEDGEABLE_MIN_QTY_BUFFER = 1.5;

export interface PerpSpec {
  minQuantity: number;
  stepSize: number;
}

export interface ClampInput {
  navUsd: number;
  allocations: Record<string, number>; // asset → pct (sums to 100)
  prices: Record<string, number>;       // asset → USD price
  hedgeRatio: number;                   // 0.5 (large) or 1.0 (tiny)
  perpSpecs: Record<string, PerpSpec>;  // asset → { minQuantity, stepSize }
  /**
   * Per-asset BlueFin open-interest snapshot in USD. If supplied and the
   * proposed hedge notional > maxOiPct% of OI, the asset is treated as
   * unhedgeable (same as failing minQty). Mirrors the T3-B OI guard so
   * the swap path doesn't take spot exposure we can't perp-hedge.
   */
  openInterestUsd?: Record<string, number>;
  maxOiPct?: number;                    // default 5
}

export interface ClampOutput {
  allocations: Record<string, number>;
  dropped: Array<{
    asset: string;
    originalPct: number;
    notionalNeeded: number;
    notionalAvailable: number;
    reason: string;
  }>;
  redistributed: boolean;
}

/**
 * Returns true iff a perp position of (NAV × alloc% × ratio) can be
 * opened on BlueFin for this asset.
 *
 * The check uses the cron's own sizing (hedgeSizeBase):
 *   sizeBase    = NAV × alloc% × ratio / price
 *   snappedSize = sizeBase snapped down to the step
 *   hedgeable iff snappedSize >= 1.5 × minQuantity (the open path's own floor)
 *
 * Leverage does not make a small allocation hedgeable: it changes the margin
 * behind a position, not its size. An asset the pool is too small to hedge
 * is dropped, and its share goes to the assets that can be hedged (see
 * clampAllocationsToHedgeable); when none can, the caller holds USDC.
 */
export function isHedgeable(
  navUsd: number,
  allocationPct: number,
  hedgeRatio: number,
  price: number,
  spec: PerpSpec,
): { ok: boolean; sizeBase: number; snappedSize: number; notional: number } {
  if (allocationPct <= 0 || price <= 0) return { ok: false, sizeBase: 0, snappedSize: 0, notional: 0 };
  const sizeBase = hedgeSizeBase(navUsd, allocationPct, hedgeRatio, price);
  const snappedSize = snapToStepSize(sizeBase, spec.stepSize);
  const notional = snappedSize * price;
  return { ok: snappedSize >= spec.minQuantity * HEDGEABLE_MIN_QTY_BUFFER, sizeBase, snappedSize, notional };
}

/**
 * Clamp allocations to assets that can clear BlueFin's minQty at this
 * NAV + leverage. Dropped-asset shares are redistributed proportionally
 * to the surviving assets, preserving the 100% total.
 *
 * Edge cases:
 *   - If NO asset is hedgeable, returns the original allocations
 *     unchanged with redistributed=false. Caller decides whether to
 *     skip the entire cycle or fall back to all-USDC.
 *   - If exactly one asset is hedgeable, it gets the full 100% alloc.
 *   - If an asset's price is missing (price = 0), it's treated as
 *     unhedgeable and dropped (defensive — price feed glitch shouldn't
 *     authorise unhedged exposure).
 */
export function clampAllocationsToHedgeable(input: ClampInput): ClampOutput {
  const { navUsd, allocations, prices, hedgeRatio, perpSpecs, openInterestUsd, maxOiPct } = input;
  const oiPct = Math.max(0.5, maxOiPct ?? 5);
  const assets = Object.keys(allocations);

  const dropped: ClampOutput['dropped'] = [];
  const survivors: string[] = [];
  let survivorPctSum = 0;

  for (const asset of assets) {
    const pct = Number(allocations[asset] || 0);
    if (pct <= 0) continue; // already zero — don't list as dropped
    const spec = perpSpecs[asset];
    const price = Number(prices[asset] || 0);
    if (!spec) {
      // Unknown symbol — keep allocation; caller's responsibility.
      survivors.push(asset);
      survivorPctSum += pct;
      continue;
    }
    const check = isHedgeable(navUsd, pct, hedgeRatio, price, spec);
    if (!check.ok) {
      dropped.push({
        asset,
        originalPct: pct,
        notionalNeeded: spec.minQuantity * price,
        notionalAvailable: navUsd * (pct / 100) * hedgeRatio,
        reason: price <= 0
          ? `no price for ${asset}`
          : `NAV $${navUsd.toFixed(2)} × ${pct}% × ratio ${hedgeRatio} = ${check.snappedSize} ${asset} < minQty ${spec.minQuantity}`,
      });
      continue;
    }
    // Check OI constraint if provided. Hedge notional = snappedSize × price.
    const oi = openInterestUsd?.[asset];
    if (typeof oi === 'number' && oi > 0) {
      const proposedNotional = check.notional;
      const maxAllowedByOi = oi * (oiPct / 100);
      if (proposedNotional > maxAllowedByOi) {
        dropped.push({
          asset,
          originalPct: pct,
          notionalNeeded: proposedNotional,
          notionalAvailable: maxAllowedByOi,
          reason: `hedge notional $${proposedNotional.toFixed(2)} > ${oiPct}% of venue OI $${oi.toFixed(0)} (max $${maxAllowedByOi.toFixed(2)})`,
        });
        continue;
      }
    }
    survivors.push(asset);
    survivorPctSum += pct;
  }

  if (dropped.length === 0) {
    return { allocations: { ...allocations }, dropped: [], redistributed: false };
  }

  // No survivor — return originals; caller falls back.
  if (survivors.length === 0 || survivorPctSum <= 0) {
    return { allocations: { ...allocations }, dropped, redistributed: false };
  }

  // Redistribute droppedPctSum proportionally across survivors.
  const adjusted: Record<string, number> = {};
  for (const asset of assets) adjusted[asset] = 0;
  let allocatedSoFar = 0;
  for (let i = 0; i < survivors.length; i++) {
    const s = survivors[i];
    const isLast = i === survivors.length - 1;
    const originalSurvPct = Number(allocations[s] || 0);
    const share = isLast
      ? 100 - allocatedSoFar          // absorb rounding remainder in last asset
      : Math.round(((originalSurvPct / survivorPctSum) * 100 + Number.EPSILON) * 100) / 100;
    adjusted[s] = share;
    allocatedSoFar += share;
  }

  return { allocations: adjusted, dropped, redistributed: true };
}
