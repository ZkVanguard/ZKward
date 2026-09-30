/**
 * Pure share math for the Solana token pool.
 *
 * v1 (testnet branch): no trading, no buybacks, so share price is 1.0 by
 * construction and deposits mint 1:1. The general machinery is here so the
 * mainnet phase (buybacks raise vault balance without minting) changes the
 * inputs, not the math.
 *
 * All amounts are RAW base units (bigint, 6-decimal token) — floats never
 * touch accounting. UI conversion happens at the edge.
 */

export const TOKEN_DECIMALS = 6;

/** Share price in token base-units per share-unit, as a rational pair. */
export function sharePrice(vaultTokensRaw: bigint, totalSharesRaw: bigint): {
  num: bigint;
  den: bigint;
} {
  if (totalSharesRaw <= 0n) return { num: 1n, den: 1n }; // empty pool bootstraps at 1.0
  return { num: vaultTokensRaw, den: totalSharesRaw };
}

/**
 * Shares minted for a deposit at the CURRENT share price (balance BEFORE the
 * deposit). Floor rounding — the pool never over-mints; dust favors existing
 * holders, matching the SUI pool's convention.
 */
export function sharesForDeposit(
  depositRaw: bigint,
  vaultTokensBeforeRaw: bigint,
  totalSharesRaw: bigint,
): bigint {
  if (depositRaw <= 0n) return 0n;
  const p = sharePrice(vaultTokensBeforeRaw, totalSharesRaw);
  // shares = deposit / price = deposit * den / num
  if (p.num <= 0n) return depositRaw; // degenerate empty-vault state → 1:1
  return (depositRaw * p.den) / p.num;
}

export function toUi(raw: bigint, decimals: number = TOKEN_DECIMALS): number {
  return Number(raw) / 10 ** decimals;
}

export function fromUi(ui: number, decimals: number = TOKEN_DECIMALS): bigint {
  return BigInt(Math.round(ui * 10 ** decimals));
}
