/**
 * Per-action POST handlers for /api/community-pool.
 *
 * Extracted from route.ts (2026-08-30) — each action was a 100-200 LOC
 * switch case that mixed auth, on-chain verification, DB writes, and
 * response shaping. Splitting into named handlers keeps the route file
 * as a thin dispatcher and lets each flow be reasoned about in isolation.
 *
 * Handler signatures are uniform: they take a HandlerContext and return
 * a NextResponse. Auth + rate-limiting still live in route.ts (they
 * apply to every case).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { logger } from '@/lib/utils/logger';
// Cronos community pool retired 2026-09-25. Deposit/withdraw for the SUI
// pool go through /api/community-pool/deposit-usdt + the Move contract via
// useCommunityPool; these stubs fail if any legacy Cronos path is hit.
const cronosRetired = () => { throw new Error('Cronos pool retired'); };
const deposit = (..._args: unknown[]) => cronosRetired() as any;
const withdraw = (..._args: unknown[]) => cronosRetired() as any;
import { clearCaches as clearStatsCaches } from '@/lib/services/CommunityPoolStatsService';
import {
  resetNavHistory,
  savePoolStateToDb,
  saveUserSharesToDb,
  deleteUserSharesFromDb,
} from '@/lib/db/community-pool';
import { clearRpcCaches } from '@/lib/community-pool/cache';
import {
  verifyOnChainDeposit,
  verifyOnChainWithdraw,
} from '@/lib/community-pool/on-chain-verifier';
import {
  getOnChainPoolData,
  getOnChainUserPosition,
  getAllOnChainMembers,
  buildAllocationsForDb,
} from '@/lib/community-pool/on-chain-reader';
import type { ChainConfig } from '@/lib/community-pool/types';

export interface HandlerContext {
  request: NextRequest;
  chainConfig: ChainConfig;
  walletAddress: string;
  amount?: number;
  shares?: number;
  txHash?: string;
}

/** Timing-safe cron secret check (duplicated locally to avoid cross-file coupling). */
function verifyCronSecret(request: NextRequest): boolean {
  const cronSecret = request.headers.get('x-cron-secret');
  const expectedSecret = process.env.CRON_SECRET;
  if (!cronSecret || !expectedSecret) return false;
  if (cronSecret.length !== expectedSecret.length) return false;
  return timingSafeEqual(Buffer.from(cronSecret), Buffer.from(expectedSecret));
}

// ============================================================================
// deposit — verify on-chain then record + sync
// ============================================================================
export async function handleDeposit(ctx: HandlerContext): Promise<NextResponse> {
  const { walletAddress, amount, txHash, chainConfig } = ctx;

  if (!txHash) {
    return NextResponse.json(
      { success: false, error: 'Transaction hash (txHash) is required. Deposit must be made on-chain first.' },
      { status: 400 },
    );
  }
  if (!amount || amount <= 0) {
    return NextResponse.json({ success: false, error: 'Valid deposit amount required' }, { status: 400 });
  }

  const verification = await verifyOnChainDeposit(txHash, walletAddress, chainConfig);
  if (!verification.verified) {
    logger.warn(`[CommunityPool] Deposit verification failed: ${verification.error}`, { txHash, walletAddress });
    return NextResponse.json(
      { success: false, error: `On-chain verification failed: ${verification.error}` },
      { status: 400 },
    );
  }

  // On-chain amount is source of truth (prevents client-side manipulation).
  const verifiedAmount = verification.amountUSD;
  if (Math.abs(verifiedAmount - amount) > 0.01) {
    logger.warn(`[CommunityPool] Amount mismatch: client=${amount}, on-chain=${verifiedAmount}`, { txHash });
  }

  const result = await deposit(walletAddress, verifiedAmount, txHash, chainConfig.chainKey);
  if (!result.success) {
    return NextResponse.json({ success: false, error: result.error }, { status: 400 });
  }

  // Post-deposit on-chain sync — non-fatal; local calc already saved.
  try {
    const onChainUser = await getOnChainUserPosition(walletAddress, chainConfig);
    const onChainPool = await getOnChainPoolData(chainConfig);
    if (onChainUser && onChainPool) {
      await saveUserSharesToDb({
        walletAddress: walletAddress.toLowerCase(),
        shares: onChainUser.shares,
        costBasisUSD: onChainUser.valueUSD,
        chain: chainConfig.chainKey,
      });
      await savePoolStateToDb({
        totalValueUSD: onChainPool.totalValueUSD,
        totalShares: onChainPool.totalShares,
        sharePrice: onChainPool.sharePrice,
        allocations: buildAllocationsForDb(onChainPool),
        lastRebalance: Date.now(),
        lastAIDecision: null,
        chain: chainConfig.chainKey,
      });
      logger.info(`[CommunityPool] Post-deposit on-chain sync: ${walletAddress} has ${onChainUser.shares} shares`);
    }
  } catch (syncError) {
    logger.error('[CommunityPool] Post-deposit on-chain sync failed (non-fatal)', syncError);
  }

  return NextResponse.json({
    success: true,
    message: `Deposited $${amount.toLocaleString()} and received ${result.sharesReceived.toFixed(4)} shares`,
    deposit: {
      amountUSD: amount,
      sharesReceived: result.sharesReceived,
      sharePrice: result.sharePrice,
      newTotalShares: result.newTotalShares,
      ownershipPercentage: result.ownershipPercentage,
    },
    txHash,
  });
}

// ============================================================================
// withdraw — verify on-chain then record + sync (or delete row if fully out)
// ============================================================================
export async function handleWithdraw(ctx: HandlerContext): Promise<NextResponse> {
  const { walletAddress, shares, txHash, chainConfig } = ctx;

  if (!txHash) {
    return NextResponse.json(
      { success: false, error: 'Transaction hash (txHash) is required. Withdrawal must be made on-chain first.' },
      { status: 400 },
    );
  }
  if (!shares || shares <= 0) {
    return NextResponse.json({ success: false, error: 'Valid share amount required' }, { status: 400 });
  }

  const verification = await verifyOnChainWithdraw(txHash, walletAddress, chainConfig);
  if (!verification.verified) {
    logger.warn(`[CommunityPool] Withdrawal verification failed: ${verification.error}`, { txHash, walletAddress });
    return NextResponse.json(
      { success: false, error: `On-chain verification failed: ${verification.error}` },
      { status: 400 },
    );
  }

  const verifiedShares = verification.sharesBurned;
  if (Math.abs(verifiedShares - shares) > 0.0001) {
    logger.warn(`[CommunityPool] Shares mismatch: client=${shares}, on-chain=${verifiedShares}`, { txHash });
  }

  const result = await withdraw(walletAddress, verifiedShares, txHash, undefined, chainConfig.chainKey);
  if (!result.success) {
    return NextResponse.json({ success: false, error: result.error }, { status: 400 });
  }

  try {
    const onChainUser = await getOnChainUserPosition(walletAddress, chainConfig);
    const onChainPool = await getOnChainPoolData(chainConfig);
    if (onChainPool) {
      await savePoolStateToDb({
        totalValueUSD: onChainPool.totalValueUSD,
        totalShares: onChainPool.totalShares,
        sharePrice: onChainPool.sharePrice,
        allocations: buildAllocationsForDb(onChainPool),
        lastRebalance: Date.now(),
        lastAIDecision: null,
        chain: chainConfig.chainKey,
      });
    }
    if (onChainUser && onChainUser.shares > 0) {
      await saveUserSharesToDb({
        walletAddress: walletAddress.toLowerCase(),
        shares: onChainUser.shares,
        costBasisUSD: onChainUser.valueUSD,
        chain: chainConfig.chainKey,
      });
    } else {
      await deleteUserSharesFromDb(walletAddress, chainConfig.chainKey);
    }
    logger.info(`[CommunityPool] Post-withdraw on-chain sync: ${walletAddress} has ${onChainUser?.shares || 0} shares`);
  } catch (syncError) {
    logger.error('[CommunityPool] Post-withdraw on-chain sync failed (non-fatal)', syncError);
  }

  return NextResponse.json({
    success: true,
    message: `Burned ${result.sharesBurned.toFixed(4)} shares and received $${result.amountUSD.toFixed(2)}`,
    withdrawal: {
      sharesBurned: result.sharesBurned,
      amountUSD: result.amountUSD,
      sharePrice: result.sharePrice,
      remainingShares: result.remainingShares,
    },
    txHash,
  });
}

// ============================================================================
// sync-from-chain (admin) — pull on-chain state + members + reset NAV history
// ============================================================================
export async function handleSyncFromChain(ctx: HandlerContext): Promise<NextResponse> {
  if (!verifyCronSecret(ctx.request)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const { chainConfig } = ctx;
  const onChainData = await getOnChainPoolData(chainConfig);
  if (!onChainData) {
    return NextResponse.json({ success: false, error: 'Failed to fetch on-chain data' }, { status: 500 });
  }

  await savePoolStateToDb({
    totalValueUSD: onChainData.totalValueUSD,
    totalShares: onChainData.totalShares,
    sharePrice: onChainData.sharePrice,
    allocations: buildAllocationsForDb(onChainData),
    lastRebalance: Date.now(),
    lastAIDecision: null,
    chain: chainConfig.chainKey,
  });

  const onChainMembers = await getAllOnChainMembers(chainConfig);
  const syncedMembers: string[] = [];
  if (onChainMembers && onChainMembers.length > 0) {
    logger.info(`[CommunityPool API] Syncing ${onChainMembers.length} on-chain members to database`);
    for (const member of onChainMembers) {
      await saveUserSharesToDb({
        walletAddress: member.walletAddress,
        shares: member.shares,
        costBasisUSD: member.depositedUSD,
        chain: chainConfig.chainKey,
      });
      syncedMembers.push(member.walletAddress);
      logger.info(`[CommunityPool API] Synced member ${member.walletAddress}: ${member.shares} shares`);
    }
  }

  const syncAllocPct: Record<string, number> = {};
  if (onChainData.allocations) {
    for (const [asset, data] of Object.entries(onChainData.allocations)) {
      syncAllocPct[asset] = (data as { percentage: number }).percentage;
    }
  }
  const resetResult = await resetNavHistory(
    onChainData.totalValueUSD,
    onChainData.sharePrice,
    onChainData.totalShares,
    onChainData.totalMembers,
    syncAllocPct,
  );

  return NextResponse.json({
    success: true,
    message: 'Database synced with on-chain state',
    onChainData: {
      totalValueUSD: onChainData.totalValueUSD,
      totalShares: onChainData.totalShares,
      sharePrice: onChainData.sharePrice,
      totalMembers: onChainData.totalMembers,
    },
    syncedMembers,
    navHistoryReset: resetResult,
  });
}

// ============================================================================
// delete-user (admin) — remove one stale user row for a chain
// ============================================================================
export async function handleDeleteUser(ctx: HandlerContext): Promise<NextResponse> {
  if (!verifyCronSecret(ctx.request)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  const { walletAddress, chainConfig } = ctx;
  if (!walletAddress) {
    return NextResponse.json({ success: false, error: 'walletAddress required' }, { status: 400 });
  }
  await deleteUserSharesFromDb(walletAddress.toLowerCase(), chainConfig.chainKey);
  return NextResponse.json({
    success: true,
    message: `Deleted user ${walletAddress} from database for chain ${chainConfig.chainKey}`,
  });
}

// ============================================================================
// full-reset (admin) — nuke all DB state for a chain + rebuild from on-chain
// ============================================================================
export async function handleFullReset(ctx: HandlerContext): Promise<NextResponse> {
  if (!verifyCronSecret(ctx.request)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const { chainConfig } = ctx;
  logger.info('[CommunityPool API] Starting full reset to on-chain V3 state');

  const onChainData = await getOnChainPoolData(chainConfig);
  if (!onChainData) {
    return NextResponse.json({ success: false, error: 'Failed to fetch on-chain data' }, { status: 500 });
  }

  const onChainMembers = await getAllOnChainMembers(chainConfig);
  if (!onChainMembers) {
    return NextResponse.json({ success: false, error: 'Failed to fetch on-chain members' }, { status: 500 });
  }

  const { query: dbQuery } = await import('@/lib/db/postgres');
  const deletedUsers = await dbQuery(
    'DELETE FROM community_pool_shares WHERE chain = $1 RETURNING wallet_address',
    [chainConfig.chainKey],
  );
  logger.info(
    `[CommunityPool API] Deleted ${deletedUsers.length} users from database for chain ${chainConfig.chainKey}`,
  );

  const syncedMembers: { address: string; shares: number }[] = [];
  const activeMembers = onChainMembers.filter((m) => m.shares > 0);
  for (const member of activeMembers) {
    await saveUserSharesToDb({
      walletAddress: member.walletAddress.toLowerCase(),
      shares: member.shares,
      costBasisUSD: member.depositedUSD,
      chain: chainConfig.chainKey,
    });
    syncedMembers.push({ address: member.walletAddress, shares: member.shares });
    logger.info(`[CommunityPool API] Synced member: ${member.walletAddress} (${member.shares} shares)`);
  }

  const allocations = buildAllocationsForDb(onChainData);
  await savePoolStateToDb({
    totalValueUSD: onChainData.totalValueUSD,
    totalShares: onChainData.totalShares,
    sharePrice: onChainData.sharePrice,
    allocations,
    lastRebalance: Date.now(),
    lastAIDecision: null,
    chain: chainConfig.chainKey,
  });

  const resetAllocPct: Record<string, number> = {};
  for (const [asset, data] of Object.entries(allocations)) {
    resetAllocPct[asset] = data.percentage;
  }
  const navReset = await resetNavHistory(
    onChainData.totalValueUSD,
    onChainData.sharePrice,
    onChainData.totalShares,
    activeMembers.length,
    resetAllocPct,
  );

  clearStatsCaches();
  clearRpcCaches();
  logger.info('[CommunityPool API] Full reset completed successfully');

  return NextResponse.json({
    success: true,
    message: 'Full reset completed - all data now matches on-chain V3 contract',
    summary: {
      deletedStaleUsers: deletedUsers.length,
      syncedActiveMembers: syncedMembers.length,
      navHistoryDeleted: navReset.deleted,
      poolState: {
        totalValueUSD: onChainData.totalValueUSD,
        totalShares: onChainData.totalShares,
        sharePrice: onChainData.sharePrice,
        memberCount: activeMembers.length,
        allocations: {
          BTC: onChainData.allocations.BTC.percentage,
          ETH: onChainData.allocations.ETH.percentage,
          SUI: onChainData.allocations.SUI.percentage,
          CRO: onChainData.allocations.CRO.percentage,
        },
      },
      members: syncedMembers,
    },
    timestamp: new Date().toISOString(),
  });
}
