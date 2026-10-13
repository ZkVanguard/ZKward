/**
 * The pool job wrote each member's current position value as their cost basis
 * on every run, so a pool down two thirds showed every member at break-even.
 * The basis is the capital the contract recorded: deposited less withdrawn.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const saveUserSharesToDb = jest.fn(async (_row: { walletAddress: string; shares: number; costBasisUSD: number; chain: string }) => {});
jest.mock('@/lib/db/community-pool', () => ({
  saveUserSharesToDb,
  recordNavSnapshot: jest.fn(),
  savePoolStateToDb: jest.fn(),
  getNavHistory: jest.fn(),
}));

import { memberCostBasisUsd, syncMembersToDb } from '@/lib/services/sui/cron/persistence';

describe('pool member cost basis', () => {
  beforeEach(() => saveUserSharesToDb.mockClear());

  it('is deposited less withdrawn, never below zero', () => {
    expect(memberCostBasisUsd({ depositedSui: 55, withdrawnSui: 0 })).toBe(55);
    expect(memberCostBasisUsd({ depositedSui: 55, withdrawnSui: 20 })).toBe(35);
    expect(memberCostBasisUsd({ depositedSui: 10, withdrawnSui: 14 })).toBe(0);
  });

  it('the member sync writes the deposited capital, not the current value', async () => {
    await syncMembersToDb({
      suiService: {
        getAllMembers: async () => [
          { address: '0x' + 'a'.repeat(64), shares: 67.3, depositedSui: 55, withdrawnSui: 0, valueUsd: 18.26, valueSui: 18.26 },
          { address: '0x' + 'b'.repeat(64), shares: 0, depositedSui: 5, withdrawnSui: 5, valueUsd: 0, valueSui: 0 },
        ],
      },
    });
    expect(saveUserSharesToDb).toHaveBeenCalledTimes(1);
    expect(saveUserSharesToDb.mock.calls[0][0]).toMatchObject({ shares: 67.3, costBasisUSD: 55, chain: 'sui' });
  });
});
