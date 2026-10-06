/**
 * Integer arithmetic for two calls into the pool contract, where an
 * off-by-one or a too-large step makes the transaction abort on chain.
 * Pure, so the rules the contract enforces are tested here without a chain.
 */

/** The contract allows 30% per attestation; steps stay a little inside it. */
export const ATTEST_STEP_BPS = 2900n;
const BPS = 10_000n;

/**
 * The attested external value may move at most 30% from the value before it.
 * Returns the chain of values that gets from `priorRaw` to `targetRaw` with
 * every link inside that bound; one element when a single attestation is
 * enough. All links go in one transaction, so no price between them is ever
 * transactable.
 *
 * `null` when the target cannot be reached in `maxSteps`: a fall to zero never
 * converges, because 30% of the remainder always leaves a remainder.
 */
export function attestPath(priorRaw: bigint, targetRaw: bigint, maxSteps = 16): bigint[] | null {
  if (priorRaw < 0n || targetRaw < 0n) return null;
  // First attestation: the contract has no prior to compare with.
  if (priorRaw === 0n) return [targetRaw];

  const path: bigint[] = [];
  let current = priorRaw;
  while (path.length < maxSteps) {
    const delta = targetRaw > current ? targetRaw - current : current - targetRaw;
    if (delta * BPS <= current * ATTEST_STEP_BPS) {
      path.push(targetRaw);
      return path;
    }
    const step = (current * ATTEST_STEP_BPS) / BPS;
    if (step === 0n) return null;
    current = targetRaw > current ? current + step : current - step;
    path.push(current);
  }
  return null;
}

/**
 * Arguments for `close_hedge` when `returnRaw` of USDC comes back for a hedge
 * that took `collateralRaw` out.
 *
 * The contract requires the coin to be at least `collateral + pnl` (profit)
 * or `collateral - pnl` (loss). Flooring the return and the loss separately
 * from decimals can leave the coin one unit short and abort the close, so the
 * loss is derived from the two integers and the identity holds exactly.
 */
export function closeHedgeArgs(collateralRaw: bigint, returnRaw: bigint): { amountRaw: bigint; pnlRaw: bigint; isProfit: boolean } {
  if (collateralRaw < 0n || returnRaw < 0n) throw new Error('closeHedgeArgs: negative amount');
  const isProfit = returnRaw >= collateralRaw;
  const pnlRaw = isProfit ? returnRaw - collateralRaw : collateralRaw - returnRaw;
  return { amountRaw: returnRaw, pnlRaw, isProfit };
}

/**
 * Split `availableRaw` across hedges in proportion to their collateral, in
 * whole units, never handing out more than is available.
 */
export function splitProRata(availableRaw: bigint, collateralsRaw: bigint[]): bigint[] {
  const total = collateralsRaw.reduce((a, b) => a + b, 0n);
  if (total === 0n) return collateralsRaw.map(() => 0n);
  return collateralsRaw.map((c) => (availableRaw * c) / total);
}
