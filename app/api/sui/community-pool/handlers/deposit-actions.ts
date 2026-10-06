/**
 * Deposit POST-action handlers for the sui/community-pool route.
 *
 * Extracted from route.ts on 2026-08-10.
 */
import { NextResponse } from 'next/server';
import { logger } from '@/lib/utils/logger';
import { verifyCronRequest } from '@/lib/qstash';
import { getSuiUsdcPoolService } from '@/lib/services/sui/SuiCommunityPoolService';
import { getBluefinAggregatorService, type PoolAsset } from '@/lib/services/sui/BluefinAggregatorService';
import { withWalletLock } from './wallet-lock';
import { provePoolTx } from './pool-tx-proof';
import type { ActionCtx } from './types';

export async function handleDeposit(ctx: ActionCtx): Promise<NextResponse> {
  const { network, body } = ctx;
  const amount = body.amount;
  if (!amount) {
    return NextResponse.json({ success: false, error: 'Amount required (in MIST or SUI)' }, { status: 400 });
  }

  // CRITICAL: validate positive amount to prevent negative-value attacks.
  // BigInt() throws on invalid input; catch → 400 not 500.
  let amountRaw: bigint;
  try {
    amountRaw = BigInt(amount as string | number | bigint);
  } catch {
    return NextResponse.json({ success: false, error: 'Amount must be an integer (USDC base units)' }, { status: 400 });
  }
  if (amountRaw <= 0n) {
    return NextResponse.json({ success: false, error: 'Amount must be positive' }, { status: 400 });
  }
  const MAX_DEPOSIT_RAW = 1_000_000_000_000_000n; // 1B USDC * 10^6
  if (amountRaw > MAX_DEPOSIT_RAW) {
    return NextResponse.json({ success: false, error: 'Amount exceeds maximum deposit (1B USDC)' }, { status: 400 });
  }

  const service = getSuiUsdcPoolService(network);
  await service.getPoolStats();

  const amountUsdc = Number(amountRaw) / 1_000_000;
  const params = service.buildDepositParams(amountUsdc);
  service.clearCaches();

  return NextResponse.json({
    success: true,
    data: {
      target: params.target,
      poolStateId: params.poolStateId,
      amountRaw: params.amountRaw.toString(),
      clockId: params.clockId,
      usdcCoinType: params.usdcCoinType,
      typeArg: params.typeArg,
    },
    chain: 'sui',
    network,
  });
}

export async function handleExecuteDepositSwaps(ctx: ActionCtx): Promise<NextResponse> {
  const { request, network, body } = ctx;
  const authResult = await verifyCronRequest(request, 'SUI execute-deposit-swaps');
  if (authResult !== true) {
    return NextResponse.json({ success: false, error: 'Unauthorized — admin operation requires authentication' }, { status: 401 });
  }

  const amountUsdc = body.amountUsdc;
  const allocations = body.allocations;

  if (!amountUsdc || typeof amountUsdc !== 'number' || amountUsdc <= 0) {
    return NextResponse.json({ success: false, error: 'amountUsdc required (positive number)' }, { status: 400 });
  }
  if (!allocations || typeof allocations !== 'object') {
    return NextResponse.json({ success: false, error: 'allocations required (e.g. { BTC: 30, ETH: 30, SUI: 25, CRO: 15 })' }, { status: 400 });
  }

  const aggregator = getBluefinAggregatorService(network);

  const wallet = await aggregator.checkAdminWallet();
  if (!wallet.configured || !wallet.hasGas) {
    return NextResponse.json({ success: false, error: 'Admin wallet not configured or insufficient gas' }, { status: 503 });
  }

  const plan = await aggregator.planRebalanceSwaps(amountUsdc, allocations as Record<PoolAsset, number>);
  const onChainSwaps = plan.swaps.filter(s => s.canSwapOnChain && s.routerData);
  const hedgedSwaps = plan.swaps.filter(s => !s.canSwapOnChain && s.hedgeVia === 'bluefin');

  if (onChainSwaps.length === 0 && hedgedSwaps.length === 0) {
    return NextResponse.json({
      success: false,
      data: { message: 'No on-chain swaps or hedges available for these assets', plan },
      chain: 'sui',
    }, { status: 400 });
  }

  const result = await aggregator.executeRebalance(plan, 0.01);

  logger.info('[SUI-API] Deposit swaps executed', {
    amountUsdc,
    executed: result.totalExecuted,
    failed: result.totalFailed,
    hedged: hedgedSwaps.length,
    digests: result.results.filter(r => r.txDigest).map(r => `${r.asset}:${r.txDigest}`),
  });

  return NextResponse.json({
    success: result.success,
    data: {
      executed: result.totalExecuted,
      failed: result.totalFailed,
      results: result.results.map(r => ({
        asset: r.asset,
        success: r.success,
        txDigest: r.txDigest,
        amountIn: r.amountIn,
        amountOut: r.amountOut,
        error: r.error,
      })),
    },
    chain: 'sui',
  });
}

export async function handleDryRunDepositSwaps(ctx: ActionCtx): Promise<NextResponse> {
  const { network, body } = ctx;
  const amountUsdc = body.amountUsdc;
  const allocations = body.allocations;

  if (!amountUsdc || typeof amountUsdc !== 'number' || amountUsdc <= 0) {
    return NextResponse.json({ success: false, error: 'amountUsdc required (positive number)' }, { status: 400 });
  }
  if (!allocations || typeof allocations !== 'object') {
    return NextResponse.json({ success: false, error: 'allocations required (e.g. { BTC: 30, ETH: 30, SUI: 25, CRO: 15 })' }, { status: 400 });
  }

  const aggregator = getBluefinAggregatorService(network);
  const wallet = await aggregator.checkAdminWallet();

  const plan = await aggregator.planRebalanceSwaps(amountUsdc, allocations as Record<PoolAsset, number>);
  const result = await aggregator.executeRebalance(plan, 0.01, { dryRun: true });

  return NextResponse.json({
    success: true,
    data: {
      dryRun: true,
      wallet: { configured: wallet.configured, hasGas: wallet.hasGas, address: wallet.address },
      plan: {
        totalUsdcToSwap: plan.totalUsdcToSwap,
        swaps: plan.swaps.map(s => ({
          asset: s.asset,
          amountIn: s.amountIn,
          expectedAmountOut: s.expectedAmountOut,
          canSwapOnChain: s.canSwapOnChain,
          hedgeVia: s.hedgeVia,
        })),
      },
      execution: {
        executed: result.totalExecuted,
        failed: result.totalFailed,
        results: result.results,
      },
      hedgeValidation: result.dryRunDetails || [],
    },
    chain: 'sui',
  });
}

/**
 * Record a deposit the wallet has already made on chain.
 *
 * The body only names the transaction. Who deposited, how much and how many
 * shares come from the event the pool contract emitted in it. This action
 * writes history rows and never signs or swaps anything: allocation of new
 * deposits is the authenticated cron's job.
 */
export async function handleRecordDeposit(ctx: ActionCtx): Promise<NextResponse> {
  const { network } = ctx;
  const proven = await provePoolTx(ctx, 'UsdcDeposited');
  if (proven instanceof NextResponse) return proven;
  const { walletAddress, txDigest, proof } = proven;
  const amountUsdc = proof.amountUsdc;
  const sharesMinted = proof.shares;

  const service = getSuiUsdcPoolService(network);
  const { getUserSharesFromDb, saveUserSharesToDb, addPoolTransactionToDb } = await import('@/lib/db/community-pool');

  return withWalletLock(walletAddress, async () => {
    let newTotalShares = sharesMinted;
    let onChainVerified = false;
    const existingShares = await getUserSharesFromDb(walletAddress, 'sui');
    const newCostBasis = (existingShares?.cost_basis_usd || 0) + amountUsdc;

    try {
      service.clearCaches();
      const onChainPos = await service.getMemberPosition(walletAddress);
      if (onChainPos.isMember && onChainPos.shares > 0) {
        newTotalShares = onChainPos.shares;
        onChainVerified = true;
      } else {
        newTotalShares = (existingShares?.shares || 0) + sharesMinted;
        logger.warn('[SUI-API] On-chain member not readable yet, using DB + deposit', {
          wallet: walletAddress.slice(0, 10) + '...',
          estimate: newTotalShares,
        });
      }
    } catch (err) {
      logger.error('[SUI-API] On-chain read failed during deposit recording', {
        error: err instanceof Error ? err.message : err,
      });
      newTotalShares = (existingShares?.shares || 0) + sharesMinted;
    }

    await saveUserSharesToDb({
      walletAddress,
      shares: newTotalShares,
      costBasisUSD: newCostBasis,
      chain: 'sui',
    });

    await addPoolTransactionToDb({
      id: `sui-deposit-${Date.now()}-${walletAddress.slice(-8)}`,
      type: 'DEPOSIT',
      walletAddress,
      amountUSD: amountUsdc,
      shares: sharesMinted,
      sharePrice: amountUsdc / sharesMinted,
      details: { network, txDigest, onChainVerified },
      txHash: txDigest,
    });

    logger.info('[SUI-API] USDC deposit recorded', {
      wallet: walletAddress.slice(0, 10) + '...',
      amountUsdc,
      sharesMinted,
      sharesTotal: newTotalShares,
    });

    return NextResponse.json({
      success: true,
      data: { walletAddress, amountUsdc, sharesMinted, totalShares: newTotalShares },
      chain: 'sui',
      network,
    });
  });
}
