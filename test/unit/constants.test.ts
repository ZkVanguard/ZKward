/**
 * Golden tests for portfolio-ID routing predicates (lib/constants.ts).
 * Reserved negative sentinels never collide with user portfolios
 * (assigned 0,1,2,… by RWAManager) — a regression here misroutes pool funds.
 *
 * Post-Cronos-nuke (2026-09-25): only 3 reserved IDs remain — legacy EVM (-1,
 * kept for historic rows), SUI (-2), Hedera (-3). Sepolia + the 5th slot
 * were removed with the chain surface.
 */
import { describe, it, expect } from '@jest/globals';
import {
  COMMUNITY_POOL_PORTFOLIO_ID,
  SUI_COMMUNITY_POOL_PORTFOLIO_ID,
  HEDERA_COMMUNITY_POOL_PORTFOLIO_ID,
  isCommunityPoolPortfolio,
  isSuiCommunityPool,
  chainToPortfolioId,
} from '@/lib/constants';

describe('reserved portfolio IDs', () => {
  it('are the documented negative sentinels', () => {
    expect(COMMUNITY_POOL_PORTFOLIO_ID).toBe(-1);
    expect(SUI_COMMUNITY_POOL_PORTFOLIO_ID).toBe(-2);
    expect(HEDERA_COMMUNITY_POOL_PORTFOLIO_ID).toBe(-3);
  });
});

describe('isCommunityPoolPortfolio', () => {
  it('matches every reserved pool sentinel', () => {
    for (const id of [-1, -2, -3]) {
      expect(isCommunityPoolPortfolio(id)).toBe(true);
    }
  });
  it('rejects user portfolios, unreserved negatives, and nullish', () => {
    expect(isCommunityPoolPortfolio(0)).toBe(false);
    expect(isCommunityPoolPortfolio(5)).toBe(false);
    expect(isCommunityPoolPortfolio(-4)).toBe(false);
    expect(isCommunityPoolPortfolio(-6)).toBe(false);
    expect(isCommunityPoolPortfolio(null)).toBe(false);
    expect(isCommunityPoolPortfolio(undefined)).toBe(false);
  });
});

describe('chainToPortfolioId', () => {
  it('routes each known chain to its reserved sentinel', () => {
    expect(chainToPortfolioId('sui')).toBe(SUI_COMMUNITY_POOL_PORTFOLIO_ID);
    expect(chainToPortfolioId('hedera')).toBe(HEDERA_COMMUNITY_POOL_PORTFOLIO_ID);
    // Cronos + sepolia + any other chain fall through to the legacy EVM
    // sentinel now that those routes are gone.
    expect(chainToPortfolioId('sepolia')).toBe(COMMUNITY_POOL_PORTFOLIO_ID);
    expect(chainToPortfolioId('cronos')).toBe(COMMUNITY_POOL_PORTFOLIO_ID);
    expect(chainToPortfolioId('cronos-mainnet')).toBe(COMMUNITY_POOL_PORTFOLIO_ID);
  });
  it('is case-insensitive', () => {
    expect(chainToPortfolioId('SUI')).toBe(SUI_COMMUNITY_POOL_PORTFOLIO_ID);
    expect(chainToPortfolioId('Hedera')).toBe(HEDERA_COMMUNITY_POOL_PORTFOLIO_ID);
  });
  it('falls back to legacy EVM (-1) for unknown / nullish chains', () => {
    expect(chainToPortfolioId(null)).toBe(COMMUNITY_POOL_PORTFOLIO_ID);
    expect(chainToPortfolioId(undefined)).toBe(COMMUNITY_POOL_PORTFOLIO_ID);
    expect(chainToPortfolioId('')).toBe(COMMUNITY_POOL_PORTFOLIO_ID);
    expect(chainToPortfolioId('mars')).toBe(COMMUNITY_POOL_PORTFOLIO_ID);
  });
});

describe('isSuiCommunityPool', () => {
  it('matches the SUI sentinel and the string id', () => {
    expect(isSuiCommunityPool(-2)).toBe(true);
    expect(isSuiCommunityPool('sui-usdc-pool')).toBe(true);
  });
  it('rejects the EVM sentinel, other ids, and nullish', () => {
    expect(isSuiCommunityPool(-1)).toBe(false);
    expect(isSuiCommunityPool(0)).toBe(false);
    expect(isSuiCommunityPool('other')).toBe(false);
    expect(isSuiCommunityPool(null)).toBe(false);
  });
});
