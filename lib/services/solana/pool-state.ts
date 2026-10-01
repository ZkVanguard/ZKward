/**
 * Pure share math for the Solana token pool.
 *
 * Price inputs are LEDGER-accounted tokens (credited deposits − paid
 * withdrawals, later + buyback credits), never the live vault balance: the
 * chain balance also holds deposits not yet indexed, and pricing off it
 * hands a pending depositor's tokens to whoever withdraws in the gap
 * (2026-09-29: a 20,000-share withdrawal paid 20,800). The chain balance is
 * a solvency check, not a price.
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

/** Tokens owed for burning shares at the ledger price. Floor — never overpays dust. */
export function payoutForShares(
  sharesRaw: bigint,
  accountedTokensRaw: bigint,
  totalSharesRaw: bigint,
): bigint {
  if (sharesRaw <= 0n || totalSharesRaw <= 0n || accountedTokensRaw <= 0n) return 0n;
  return (sharesRaw * accountedTokensRaw) / totalSharesRaw;
}

export function toUi(raw: bigint, decimals: number = TOKEN_DECIMALS): number {
  return Number(raw) / 10 ** decimals;
}

export function fromUi(ui: number, decimals: number = TOKEN_DECIMALS): bigint {
  return BigInt(Math.round(ui * 10 ** decimals));
}

/** Displayed share price (tokens/share) and USD NAV — the one formula the
 *  status API and the NAV-history snapshots share. */
export function ledgerValuation(
  accountedTokensRaw: bigint,
  totalSharesRaw: bigint,
  tokenUsd: number | null,
): { sharePrice: number; navUsd: number | null } {
  return {
    sharePrice: totalSharesRaw > 0n ? Number(accountedTokensRaw) / Number(totalSharesRaw) : 1,
    navUsd: tokenUsd === null ? null : toUi(accountedTokensRaw) * tokenUsd,
  };
}
