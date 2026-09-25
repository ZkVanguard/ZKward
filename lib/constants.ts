/**
 * Reserved portfolio IDs for community pools.
 *
 * Negative sentinels never collide with RWAManager-assigned uint256 IDs.
 * One reservation per chain so pools coexist in the same DB.
 *
 *   -1  Legacy EVM community pool (retained for historic rows)
 *   -2  SUI USDC community pool
 *   -3  Hedera community pool
 */
export const COMMUNITY_POOL_PORTFOLIO_ID = -1;
export const SUI_COMMUNITY_POOL_PORTFOLIO_ID = -2;
export const HEDERA_COMMUNITY_POOL_PORTFOLIO_ID = -3;

const RESERVED_POOL_IDS: ReadonlySet<number> = new Set([
  COMMUNITY_POOL_PORTFOLIO_ID,
  SUI_COMMUNITY_POOL_PORTFOLIO_ID,
  HEDERA_COMMUNITY_POOL_PORTFOLIO_ID,
]);

/**
 * Check if a portfolio ID represents any community pool.
 * Widened for multi-chain: matches every reserved sentinel.
 */
export function isCommunityPoolPortfolio(portfolioId: number | null | undefined): boolean {
  return typeof portfolioId === 'number' && RESERVED_POOL_IDS.has(portfolioId);
}

export const SUI_COMMUNITY_POOL_STATE = '0xb9b9c58c8c023723f631455c95c21ad3d3b00ba0fef91e42a90c9f648fa68f56';

/**
 * @deprecated Cronos community pool retired 2026-09-25. Only referenced by
 * dead code paths (Cronos-only functions never invoked post-nuke). Kept so
 * those paths still compile; delete after the dead-code sweep.
 */
export const COMMUNITY_POOL_ADDRESS = '0xC25A8D76DDf946C376c9004F5192C7b2c27D5d30';

export function isSuiCommunityPool(poolId: string | number | null | undefined): boolean {
  return poolId === SUI_COMMUNITY_POOL_PORTFOLIO_ID || poolId === 'sui-usdc-pool';
}

/**
 * Map a chain identifier to its reserved community-pool portfolio ID.
 * Single source of truth for chain → sentinel routing so a future
 * per-chain cron never accidentally writes with the wrong pool ID.
 *
 * Unknown chains fall back to the legacy EVM pool (-1) so callers that
 * predate a chain launch don't crash. Add the mapping here before
 * enabling a new chain's cron.
 */
export function chainToPortfolioId(chain: string | null | undefined): number {
  switch ((chain ?? '').toLowerCase()) {
    case 'sui':
      return SUI_COMMUNITY_POOL_PORTFOLIO_ID;
    case 'hedera':
      return HEDERA_COMMUNITY_POOL_PORTFOLIO_ID;
    default:
      return COMMUNITY_POOL_PORTFOLIO_ID;
  }
}
