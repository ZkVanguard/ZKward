/**
 * The three pool actions a browser may call without a credential:
 * record-deposit, record-withdraw and the withdraw preflight.
 *
 * None of them may move funds or write a row on a caller's word. The swap
 * executor, the liquidity top-up and the database writers are mocked so each
 * test can assert they were never reached.
 */
import { describe, it, expect, beforeEach, afterAll, jest } from '@jest/globals';
import type { NextRequest } from 'next/server';

const MEMBER = '0x880cfa49' + 'c'.repeat(56);
const STRANGER = '0x' + '1'.repeat(64);
const DIGEST = '4QD4t1hkn2Rv9peY1qMSVHmr2qougATtJsyFZYTsTXvK';
const PKG = '0x107292a6' + 'b'.repeat(56);
const MODULE = 'community_pool_usdc';
const POOL = '0xe814e094' + 'd'.repeat(56);

const executeRebalance = jest.fn();
const planRebalanceSwaps = jest.fn();
const executeSwap = jest.fn();
jest.mock('@/lib/services/sui/BluefinAggregatorService', () => ({
  getBluefinAggregatorService: () => ({
    executeRebalance,
    planRebalanceSwaps,
    executeSwap,
    checkAdminWallet: jest.fn(async () => ({ configured: true, hasGas: true })),
  }),
}));

const getTransactionBlock = jest.fn<(a: unknown) => Promise<unknown>>();
const getObject = jest.fn<(a: unknown) => Promise<unknown>>();
const getDynamicFieldObject = jest.fn<(a: unknown) => Promise<unknown>>();
jest.mock('@/lib/services/sui/sui-failover-transport', () => ({
  createFailoverSuiClient: () => ({ getTransactionBlock, getObject, getDynamicFieldObject }),
}));

const getMemberPosition = jest.fn<(a: string) => Promise<{ isMember: boolean; shares: number }>>();
jest.mock('@/lib/services/sui/SuiCommunityPoolService', () => ({
  getSuiUsdcPoolService: () => ({
    getContractInfo: () => ({ packageId: PKG, moduleName: MODULE }),
    getPoolStateId: async () => POOL,
    getPoolStats: jest.fn(async () => ({ sharePrice: 0.68 })),
    getMemberPosition,
    clearCaches: jest.fn(),
    buildWithdrawParams: (shares: number) => ({ target: `${PKG}::${MODULE}::withdraw`, poolStateId: '0xpool', sharesScaled: BigInt(Math.floor(shares * 1e6)), clockId: '0x6', typeArg: 'USDC' }),
  }),
}));

const txHashExists = jest.fn<(d: string) => Promise<boolean>>();
const saveUserSharesToDb = jest.fn(async (_: unknown) => {});
const deleteUserSharesFromDb = jest.fn(async (_a: unknown, _b: unknown) => {});
const addPoolTransactionToDb = jest.fn(async (_: unknown) => {});
const getUserSharesFromDb = jest.fn(async (_a: unknown, _b: unknown) => null as null | { shares: number; cost_basis_usd: number });
jest.mock('@/lib/db/community-pool', () => ({ txHashExists, saveUserSharesToDb, deleteUserSharesFromDb, addPoolTransactionToDb, getUserSharesFromDb }));

const readPoolLiquidityState = jest.fn<(n: string) => Promise<unknown>>();
const ensurePoolLiquidityForWithdraw = jest.fn<(n: string, usdc: number) => Promise<{ success: boolean }>>();
jest.mock('@/lib/services/sui/cron/pool-liquidity', () => ({ readPoolLiquidityState, ensurePoolLiquidityForWithdraw }));

jest.mock('@/lib/qstash', () => ({ verifyCronRequest: jest.fn(async () => true) }));
jest.mock('@/lib/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { handleRecordDeposit } from '@/app/api/sui/community-pool/handlers/deposit-actions';
import { handleWithdraw, handleRecordWithdraw } from '@/app/api/sui/community-pool/handlers/withdraw-actions';

const ctx = (body: Record<string, unknown>) => ({
  request: { url: 'https://example.test/api/sui/community-pool' } as unknown as NextRequest,
  network: 'mainnet' as const,
  body,
});
const depositTx = (member = MEMBER) => ({
  effects: { status: { status: 'success' }, mutated: [{ reference: { objectId: POOL } }] },
  events: [{ type: `0x8f2534a7${'a'.repeat(56)}::${MODULE}::UsdcDeposited`, packageId: PKG, parsedJson: { member, amount_usdc: '30000000', shares_received: '43876106' } }],
});
const withdrawTx = (member = MEMBER) => ({
  effects: { status: { status: 'success' }, mutated: [{ reference: { objectId: POOL } }] },
  events: [{ type: `0x8f2534a7${'a'.repeat(56)}::${MODULE}::UsdcWithdrawn`, packageId: PKG, parsedJson: { member, shares_burned: '10000000', amount_usdc: '6837430' } }],
});
const memberOnChain = (sharesRaw: string | null) => {
  getObject.mockResolvedValue({ data: { content: { fields: { members: { fields: { id: { id: '0xtable' } } } } } } });
  getDynamicFieldObject.mockResolvedValue(
    sharesRaw === null ? { error: { code: 'dynamicFieldNotFound' } } : { data: { content: { fields: { value: { fields: { shares: sharesRaw } } } } } },
  );
};
const noWrites = () => {
  expect(saveUserSharesToDb).not.toHaveBeenCalled();
  expect(deleteUserSharesFromDb).not.toHaveBeenCalled();
  expect(addPoolTransactionToDb).not.toHaveBeenCalled();
};
const noFundsMoved = () => {
  expect(executeRebalance).not.toHaveBeenCalled();
  expect(planRebalanceSwaps).not.toHaveBeenCalled();
  expect(executeSwap).not.toHaveBeenCalled();
  expect(ensurePoolLiquidityForWithdraw).not.toHaveBeenCalled();
};

beforeEach(() => {
  jest.clearAllMocks();
  txHashExists.mockResolvedValue(false);
  getUserSharesFromDb.mockResolvedValue(null);
  getMemberPosition.mockResolvedValue({ isMember: true, shares: 67.304454 });
});

describe('record-deposit', () => {
  it('the old attack: no transaction, caller-chosen amount and allocation → refused, nothing swapped, nothing written', async () => {
    const res = await handleRecordDeposit(ctx({ walletAddress: STRANGER, amountUsdc: 9_000_000, allocations: { SUI: 100 } }));
    expect(res.status).toBe(400);
    noFundsMoved();
    noWrites();
    expect(getTransactionBlock).not.toHaveBeenCalled();
  });

  it('refuses the legacy placeholder digest that used to skip the on-chain branch', async () => {
    const res = await handleRecordDeposit(ctx({ walletAddress: STRANGER, amountUsdc: 100, txDigest: 'usdc-deposit-123', allocations: { BTC: 30, ETH: 30, SUI: 25, CRO: 15 } }));
    expect(res.status).toBe(400);
    noFundsMoved();
    noWrites();
  });

  it('refuses someone else’s real deposit', async () => {
    getTransactionBlock.mockResolvedValue(depositTx(MEMBER));
    const res = await handleRecordDeposit(ctx({ walletAddress: STRANGER, amountUsdc: 30, txDigest: DIGEST }));
    expect(res.status).toBe(403);
    noFundsMoved();
    noWrites();
  });

  it('records a real deposit with the chain’s amount and shares, ignoring the body, and still moves nothing', async () => {
    getTransactionBlock.mockResolvedValue(depositTx());
    const res = await handleRecordDeposit(ctx({ walletAddress: MEMBER, amountUsdc: 9_000_000, txDigest: DIGEST, allocations: { SUI: 100 } }));
    expect(res.status).toBe(200);
    noFundsMoved();
    expect(addPoolTransactionToDb).toHaveBeenCalledTimes(1);
    const row = addPoolTransactionToDb.mock.calls[0][0] as Record<string, unknown>;
    expect(row).toMatchObject({ type: 'DEPOSIT', walletAddress: MEMBER, amountUSD: 30, shares: 43.876106, txHash: DIGEST, chain: 'sui' });
    // history row first: its unique index is the gate for the share write
    expect(addPoolTransactionToDb.mock.invocationCallOrder[0]).toBeLessThan(saveUserSharesToDb.mock.invocationCallOrder[0]);
    expect(saveUserSharesToDb).toHaveBeenCalledWith(expect.objectContaining({ walletAddress: MEMBER, shares: 67.304454, costBasisUSD: 30 }));
  });

  it('answers a repeat of a recorded transaction without reading the chain or writing again', async () => {
    txHashExists.mockResolvedValue(true);
    const res = await handleRecordDeposit(ctx({ walletAddress: MEMBER, txDigest: DIGEST }));
    expect(res.status).toBe(200);
    expect(getTransactionBlock).not.toHaveBeenCalled();
    noWrites();
  });
});

describe('record-deposit, repeats and other pools', () => {
  it('a second post of the same transaction that slips past the first check adds nothing', async () => {
    getTransactionBlock.mockResolvedValue(depositTx());
    // not recorded when the request arrives, recorded by the time it holds the wallet lock
    txHashExists.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const res = await handleRecordDeposit(ctx({ walletAddress: MEMBER, txDigest: DIGEST }));
    expect(res.status).toBe(200);
    noWrites();
  });

  it('if the history row cannot be written, the share row is not touched', async () => {
    getTransactionBlock.mockResolvedValue(depositTx());
    addPoolTransactionToDb.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'));
    await expect(handleRecordDeposit(ctx({ walletAddress: MEMBER, txDigest: DIGEST }))).rejects.toThrow('duplicate key');
    expect(saveUserSharesToDb).not.toHaveBeenCalled();
  });

  it('refuses a real pool event from a transaction that changed some other pool', async () => {
    getTransactionBlock.mockResolvedValue({ ...depositTx(), effects: { status: { status: 'success' }, mutated: [{ reference: { objectId: '0x' + '7'.repeat(64) } }] } });
    const res = await handleRecordDeposit(ctx({ walletAddress: MEMBER, txDigest: DIGEST }));
    expect(res.status).toBe(403);
    noWrites();
  });
});

describe('record-withdraw', () => {
  it('refuses a call without a transaction', async () => {
    const res = await handleRecordWithdraw(ctx({ walletAddress: MEMBER, sharesToBurn: 67 }));
    expect(res.status).toBe(400);
    noWrites();
  });

  it('refuses to record a withdrawal against a wallet that did not make it', async () => {
    getTransactionBlock.mockResolvedValue(withdrawTx(STRANGER));
    const res = await handleRecordWithdraw(ctx({ walletAddress: MEMBER, sharesToBurn: 67, txDigest: DIGEST }));
    expect(res.status).toBe(403);
    noWrites();
  });

  it('records a real withdrawal with the chain’s shares and USDC', async () => {
    getTransactionBlock.mockResolvedValue(withdrawTx());
    memberOnChain('57304454');
    const res = await handleRecordWithdraw(ctx({ walletAddress: MEMBER, sharesToBurn: 9999, txDigest: DIGEST }));
    expect(res.status).toBe(200);
    const row = addPoolTransactionToDb.mock.calls[0][0] as Record<string, unknown>;
    expect(row).toMatchObject({ type: 'WITHDRAWAL', walletAddress: MEMBER, amountUSD: 6.83743, shares: 10, txHash: DIGEST, chain: 'sui' });
    expect(saveUserSharesToDb).toHaveBeenCalledWith(expect.objectContaining({ shares: 57.304454 }));
    expect(deleteUserSharesFromDb).not.toHaveBeenCalled();
  });

  it('removes the share row only when the chain says the wallet holds nothing', async () => {
    getTransactionBlock.mockResolvedValue(withdrawTx());
    memberOnChain(null);
    await handleRecordWithdraw(ctx({ walletAddress: MEMBER, txDigest: DIGEST }));
    expect(deleteUserSharesFromDb).toHaveBeenCalledWith(MEMBER, 'sui');
  });

  it('a failed chain read never deletes the share row of a wallet the database says still holds shares', async () => {
    getTransactionBlock.mockResolvedValue(withdrawTx());
    getObject.mockRejectedValue(new Error('429'));
    getUserSharesFromDb.mockResolvedValue({ shares: 67.304454, cost_basis_usd: 46 });
    await handleRecordWithdraw(ctx({ walletAddress: MEMBER, txDigest: DIGEST }));
    expect(deleteUserSharesFromDb).not.toHaveBeenCalled();
    expect((saveUserSharesToDb.mock.calls[0][0] as { shares: number }).shares).toBeCloseTo(57.304454, 6);
  });
});

describe('withdraw preflight', () => {
  const liquid = { totalSharesRaw: 100_000_000n, totalNavRaw: 68_000_000n, totalNavUsdc: 68, maxSingleWithdrawalBps: 10000, poolBalanceUsdc: 2 };

  it('the old attack: shares only, no wallet → refused before any chain read or top-up', async () => {
    const res = await handleWithdraw(ctx({ shares: '100000000' }));
    expect(res.status).toBe(400);
    noFundsMoved();
    expect(readPoolLiquidityState).not.toHaveBeenCalled();
  });

  it('refuses a wallet that holds no shares', async () => {
    memberOnChain(null);
    const res = await handleWithdraw(ctx({ shares: '1000000', walletAddress: STRANGER }));
    expect(res.status).toBe(403);
    noFundsMoved();
  });

  it('a page loaded before the check existed is told to reload, not shown an address error', async () => {
    const res = await handleWithdraw(ctx({ shares: '1000000' }));
    expect(((await res.json()) as { error: string }).error).toMatch(/Reload/);
  });

  it('refuses more shares than the wallet holds (two raw units over; one is inside the rounding tolerance)', async () => {
    memberOnChain('67304454');
    const res = await handleWithdraw(ctx({ shares: '67304456', walletAddress: MEMBER }));
    expect(res.status).toBe(403);
    noFundsMoved();
  });

  it('a failed ownership read answers "try again" and unwinds nothing', async () => {
    getObject.mockRejectedValue(new Error('429 rate limited'));
    const res = await handleWithdraw(ctx({ shares: '1000000', walletAddress: MEMBER }));
    expect(res.status).toBe(503);
    noFundsMoved();
  });

  it('refuses shares that are not an integer instead of crashing', async () => {
    const res = await handleWithdraw(ctx({ shares: '1.5', walletAddress: MEMBER }));
    expect(res.status).toBe(400);
    noFundsMoved();
  });

  it('a member withdrawing shares they hold gets the preflight and the transaction parameters', async () => {
    memberOnChain('67304454');
    readPoolLiquidityState.mockResolvedValue(liquid);
    ensurePoolLiquidityForWithdraw.mockResolvedValue({ success: true });
    readPoolLiquidityState.mockResolvedValueOnce(liquid).mockResolvedValueOnce({ ...liquid, poolBalanceUsdc: 60 });
    const res = await handleWithdraw(ctx({ shares: '67304454', walletAddress: MEMBER }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; data: { sharesScaled: string } };
    expect(json.success).toBe(true);
    expect(json.data.sharesScaled).toBe('67304454');
    expect(ensurePoolLiquidityForWithdraw).toHaveBeenCalledTimes(1);
    // topped up for this member's payout and no more
    expect(ensurePoolLiquidityForWithdraw.mock.calls[0][1]).toBeCloseTo(67.304454 * 0.68, 4);
  });
});

describe('a mainnet deployment refuses testnet transactions', () => {
  const testnetCtx = (body: Record<string, unknown>) => ({ ...ctx(body), network: 'testnet' as const });
  const saved = process.env.SUI_NETWORK;
  beforeEach(() => { process.env.SUI_NETWORK = 'mainnet\r\n'; });
  afterAll(() => { process.env.SUI_NETWORK = saved; });

  it('record-deposit: a free testnet deposit is not recorded beside real ones', async () => {
    getTransactionBlock.mockResolvedValue(depositTx());
    const res = await handleRecordDeposit(testnetCtx({ walletAddress: MEMBER, txDigest: DIGEST }));
    expect(res.status).toBe(400);
    expect(getTransactionBlock).not.toHaveBeenCalled();
    noWrites();
  });

  it('record-withdraw and the withdraw preflight are refused the same way', async () => {
    memberOnChain('67304454');
    expect((await handleRecordWithdraw(testnetCtx({ walletAddress: MEMBER, txDigest: DIGEST }))).status).toBe(400);
    expect((await handleWithdraw(testnetCtx({ shares: '1000000', walletAddress: MEMBER }))).status).toBe(400);
    noWrites();
    noFundsMoved();
    expect(getObject).not.toHaveBeenCalled();
  });

  it('a testnet deployment still serves testnet', async () => {
    process.env.SUI_NETWORK = 'testnet';
    getTransactionBlock.mockResolvedValue(depositTx());
    const res = await handleRecordDeposit(testnetCtx({ walletAddress: MEMBER, txDigest: DIGEST }));
    expect(res.status).toBe(200);
  });
});
