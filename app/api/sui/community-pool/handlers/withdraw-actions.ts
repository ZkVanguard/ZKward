/**
 * Withdraw POST-action handlers for the sui/community-pool route.
 *
 * Extracted from route.ts on 2026-08-10.
 */
import { NextResponse } from 'next/server';
import { logger } from '@/lib/utils/logger';
import { verifyCronRequest } from '@/lib/qstash';
import { getSuiUsdcPoolService } from '@/lib/services/sui/SuiCommunityPoolService';
import { getBluefinAggregatorService, type PoolAsset, type SwapExecutionResult } from '@/lib/services/sui/BluefinAggregatorService';
import { withWalletLock } from './wallet-lock';
import { provePoolTx, offNetworkError } from './pool-tx-proof';
import { readMemberSharesStrict } from './member-shares';
import type { ActionCtx } from './types';

/**
 * Build withdraw transaction params. Runs the pool-liquidity preflight
 * (Move `withdraw` reverts on E_INSUFFICIENT_BALANCE if pool USDC balance
 * doesn't cover payout). Tops up via mini-hedge cycle when possible,
 * otherwise returns POOL_LIQUIDITY_INSUFFICIENT with a safe max-shares
 * suggestion so the frontend can auto-fill a retry.
 */
export async function handleWithdraw(ctx: ActionCtx): Promise<NextResponse> {
  const { network, body } = ctx;
  const offNetwork = offNetworkError(network);
  if (offNetwork) return offNetwork;
  const walletAddress = body.walletAddress;
  if (walletAddress === undefined) {
    // A page loaded before this check existed does not send the wallet.
    return NextResponse.json({ success: false, error: 'This page is out of date. Reload it and try the withdrawal again.' }, { status: 400 });
  }
  if (typeof walletAddress !== 'string' || !/^0x[a-fA-F0-9]{64}$/.test(walletAddress)) {
    return NextResponse.json({ success: false, error: 'Valid SUI wallet address required (0x + 64 hex chars)' }, { status: 400 });
  }
  if (!body.shares) {
    return NextResponse.json({ success: false, error: 'Shares required (raw u64, scaled by 10^6)' }, { status: 400 });
  }
  let sharesScaled: bigint;
  try {
    sharesScaled = BigInt(body.shares as string | number | bigint);
  } catch {
    return NextResponse.json({ success: false, error: 'Shares must be an integer (raw u64, scaled by 10^6)' }, { status: 400 });
  }
  if (sharesScaled <= 0n) {
    return NextResponse.json({ success: false, error: 'Shares must be positive' }, { status: 400 });
  }
  const sharesNum = Number(sharesScaled) / 1e6;

  // The preflight below can make the server unwind positions to fund the
  // payout, so it is bounded to shares this wallet holds on chain. That stops
  // a request for shares nobody owns. It does not prove the caller is that
  // member: the wallet is a body field and member addresses are public, so
  // a stranger can still trigger a real member's preflight. Closing that
  // needs the wallet to sign the request. The lock below is per instance.
  let ownedShares: number;
  try {
    ownedShares = await readMemberSharesStrict(network, walletAddress);
  } catch (err) {
    logger.warn('[SUI-API] Withdraw preflight could not read the member position', {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { success: false, error: 'Could not read your pool position right now. Please try again in a moment.', chain: 'sui', network },
      { status: 503 },
    );
  }
  if (sharesNum > ownedShares + 1e-6) {
    return NextResponse.json(
      { success: false, error: `This wallet holds ${ownedShares.toFixed(6)} shares; cannot withdraw ${sharesNum.toFixed(6)}.`, chain: 'sui', network },
      { status: 403 },
    );
  }

  return withWalletLock(walletAddress, () => prepareWithdraw(ctx, sharesScaled, sharesNum));
}

async function prepareWithdraw(ctx: ActionCtx, sharesScaled: bigint, sharesNum: number): Promise<NextResponse> {
  const { request, network } = ctx;
  const service = getSuiUsdcPoolService(network);
  await service.getPoolStats();

  // Pool-liquidity preflight — see original inline comment block for the full
  // reasoning; TL;DR: Move-side withdraw reverts if pool balance < payout, so
  // we top up here before letting the client sign.
  try {
    const { readPoolLiquidityState, ensurePoolLiquidityForWithdraw } = await import('@/lib/services/sui/cron/pool-liquidity');
    const liq = await readPoolLiquidityState(network);
    if (liq && liq.totalSharesRaw > 0n) {
      const expectedPayoutRaw = (sharesScaled * liq.totalNavRaw) / liq.totalSharesRaw;
      const expectedPayoutUsdc = Number(expectedPayoutRaw) / 1e6;

      const maxByCapUsdc = liq.totalNavUsdc * liq.maxSingleWithdrawalBps / 10000;
      const sharePrice = liq.totalSharesRaw > 0n
        ? Number(liq.totalNavRaw) / Number(liq.totalSharesRaw)
        : 1;

      // Safety margin — pool NAV / share price / admin balances drift between
      // when the user sees an auto-filled max and when they hit retry
      // (especially the external_nav re-attest, which can shift on-chain
      // share price 20-30% in one tick). 20% covers a single attestation jump.
      const SAFETY_MARGIN_BPS = 2000;
      const applySafety = (v: number) => v * (10000 - SAFETY_MARGIN_BPS) / 10000;

      // Cap-check upfront. Payout above maxByCapUsdc reverts on-chain
      // (E_MAX_WITHDRAWAL_EXCEEDED) even if pool has enough balance.
      if (expectedPayoutUsdc > maxByCapUsdc + 0.001) {
        const safeMaxUsdc = applySafety(Math.min(maxByCapUsdc, liq.poolBalanceUsdc));
        const capShares = safeMaxUsdc / sharePrice;
        const capPct = (liq.maxSingleWithdrawalBps / 100).toFixed(1);
        return NextResponse.json({
          success: false,
          error: `Withdrawal exceeds per-transaction cap: pool allows up to ${capPct}% of NAV per tx (${capShares.toFixed(4)} shares ≈ $${safeMaxUsdc.toFixed(2)}). Split into multiple withdrawals to fully unwind ${sharesNum.toFixed(4)} shares.`,
          data: {
            code: 'POOL_LIQUIDITY_INSUFFICIENT',
            poolBalanceUsdc: liq.poolBalanceUsdc,
            expectedPayoutUsdc,
            maxWithdrawableUsdc: safeMaxUsdc,
            maxWithdrawableShares: capShares,
            maxSingleWithdrawalBps: liq.maxSingleWithdrawalBps,
            sharePrice,
          },
          chain: 'sui',
          network,
        }, { status: 503 });
      }

      // At/under cap. Try to top up pool balance for THIS specific payout.
      const topUpTarget = Math.min(expectedPayoutUsdc, maxByCapUsdc);
      const topUp = await ensurePoolLiquidityForWithdraw(network, topUpTarget);
      if (!topUp.success) {
        const liq2 = await readPoolLiquidityState(network).catch(() => null);
        const postBalance = liq2?.poolBalanceUsdc ?? liq.poolBalanceUsdc;

        // Race safety net: top-up reported failure but pool balance now covers
        // — a concurrent cron may have beaten us to the pool object. Let it
        // through — Move re-validates at signing.
        if (postBalance >= expectedPayoutUsdc + 0.001) {
          logger.info('[SUI-API] Top-up reported failure but pool balance already covers payout — proceeding', {
            expectedPayoutUsdc: expectedPayoutUsdc.toFixed(6),
            postBalance: postBalance.toFixed(6),
            topUpError: topUp.error,
          });
        } else {
          const rawMaxUsdc = Math.min(postBalance, maxByCapUsdc);
          const maxWithdrawableUsdc = applySafety(rawMaxUsdc);
          const maxWithdrawableShares = sharePrice > 0 ? maxWithdrawableUsdc / sharePrice : 0;

          let bluefinFreeUsdc: number | undefined;
          try {
            const healthRes = await fetch(`${new URL(request.url).origin}/api/health/production`, { cache: 'no-store' });
            if (healthRes.ok) {
              const health = await healthRes.json();
              const free = health?.components?.bluefin?.freeCollateral;
              if (typeof free === 'number' && free > 0) bluefinFreeUsdc = free;
            }
          } catch { /* non-critical */ }

          logger.warn('[SUI-API] Withdraw preflight top-up failed', {
            expectedPayoutUsdc: expectedPayoutUsdc.toFixed(6),
            poolBalance: postBalance.toFixed(6),
            rawMaxUsdc: rawMaxUsdc.toFixed(6),
            maxWithdrawableUsdc: maxWithdrawableUsdc.toFixed(6),
            bluefinFreeUsdc: bluefinFreeUsdc?.toFixed(6),
            error: topUp.error,
          });
          const stuckHint = bluefinFreeUsdc && bluefinFreeUsdc > 1
            ? ` Additional $${bluefinFreeUsdc.toFixed(2)} is currently held as free collateral on BlueFin and requires a manual withdrawFromMarginBank call to move back to the pool.`
            : '';
          const suggestion = maxWithdrawableShares > 0.001
            ? ` You can withdraw up to ${maxWithdrawableShares.toFixed(4)} shares (~$${maxWithdrawableUsdc.toFixed(2)}) right now without waiting.${stuckHint}`
            : ' Pool needs manual replenishment — please contact support.' + stuckHint;
          return NextResponse.json({
            success: false,
            error: `Pool liquidity insufficient for withdrawal ($${expectedPayoutUsdc.toFixed(2)} needed, pool has $${postBalance.toFixed(2)}).${suggestion} ${topUp.error || ''}`.trim(),
            data: {
              code: 'POOL_LIQUIDITY_INSUFFICIENT',
              poolBalanceUsdc: postBalance,
              expectedPayoutUsdc,
              maxWithdrawableUsdc,
              maxWithdrawableShares,
              maxSingleWithdrawalBps: liq.maxSingleWithdrawalBps,
              sharePrice,
              bluefinFreeUsdc,
            },
            chain: 'sui',
            network,
          }, { status: 503 });
        }
      }
      if (topUp.toppedUpBy) {
        logger.info('[SUI-API] Withdraw preflight topped up pool', {
          toppedUpBy: topUp.toppedUpBy.toFixed(6),
          openTx: topUp.openTxDigest,
          closeTx: topUp.closeTxDigest,
        });
      }

      // Even on top-up "success", re-verify pool balance vs exact expected
      // payout — top-up allows partial bridging, which can leave a shortfall
      // that Move would abort on.
      const liqPost = await readPoolLiquidityState(network).catch(() => null);
      const finalBalance = liqPost?.poolBalanceUsdc ?? liq.poolBalanceUsdc;
      if (finalBalance + 0.001 < expectedPayoutUsdc) {
        const rawMaxUsdc = Math.min(finalBalance, maxByCapUsdc);
        const maxWithdrawableUsdc = applySafety(rawMaxUsdc);
        const maxWithdrawableShares = sharePrice > 0 ? maxWithdrawableUsdc / sharePrice : 0;
        let bluefinFreeUsdc: number | undefined;
        try {
          const healthRes = await fetch(`${new URL(request.url).origin}/api/health/production`, { cache: 'no-store' });
          if (healthRes.ok) {
            const health = await healthRes.json();
            const free = health?.components?.bluefin?.freeCollateral;
            if (typeof free === 'number' && free > 0) bluefinFreeUsdc = free;
          }
        } catch { /* non-critical */ }
        const stuckHint = bluefinFreeUsdc && bluefinFreeUsdc > 1
          ? ` Additional $${bluefinFreeUsdc.toFixed(2)} is on BlueFin as free collateral and needs a withdrawFromMarginBank call to reach the pool.`
          : '';
        return NextResponse.json({
          success: false,
          error: `Pool topped up to $${finalBalance.toFixed(2)} but full payout $${expectedPayoutUsdc.toFixed(2)} requires more. You can withdraw up to ${maxWithdrawableShares.toFixed(4)} shares (~$${maxWithdrawableUsdc.toFixed(2)}) right now.${stuckHint}`,
          data: {
            code: 'POOL_LIQUIDITY_INSUFFICIENT',
            poolBalanceUsdc: finalBalance,
            expectedPayoutUsdc,
            maxWithdrawableUsdc,
            maxWithdrawableShares,
            maxSingleWithdrawalBps: liq.maxSingleWithdrawalBps,
            sharePrice,
            bluefinFreeUsdc,
            partialTopUp: topUp.toppedUpBy,
          },
          chain: 'sui',
          network,
        }, { status: 503 });
      }
    }
  } catch (preflightErr) {
    logger.error('[SUI-API] Withdraw preflight threw', { error: preflightErr instanceof Error ? preflightErr.message : preflightErr });
    // Fall through — let the on-chain revert surface if preflight itself broke.
  }

  const params = service.buildWithdrawParams(sharesNum);
  service.clearCaches();

  return NextResponse.json({
    success: true,
    data: {
      target: params.target,
      poolStateId: params.poolStateId,
      sharesScaled: params.sharesScaled.toString(),
      clockId: params.clockId,
      typeArg: params.typeArg,
    },
    chain: 'sui',
    network,
  });
}

export async function handleExecuteWithdrawSwaps(ctx: ActionCtx): Promise<NextResponse> {
  const { request, network, body } = ctx;
  const authResult = await verifyCronRequest(request, 'SUI execute-withdraw-swaps');
  if (authResult !== true) {
    return NextResponse.json({ success: false, error: 'Unauthorized — admin operation requires authentication' }, { status: 401 });
  }

  const withdrawUsdc = body.withdrawUsdc as number | undefined;
  const allocations = body.allocations as Record<string, number> | undefined;

  if (!withdrawUsdc || typeof withdrawUsdc !== 'number' || withdrawUsdc <= 0) {
    return NextResponse.json({ success: false, error: 'withdrawUsdc required (USDC amount to return)' }, { status: 400 });
  }
  if (!allocations || typeof allocations !== 'object') {
    return NextResponse.json({ success: false, error: 'allocations required (current pool allocations)' }, { status: 400 });
  }

  const aggregator = getBluefinAggregatorService(network);

  const wallet = await aggregator.checkAdminWallet();
  if (!wallet.configured || !wallet.hasGas) {
    return NextResponse.json({ success: false, error: 'Admin wallet not configured or insufficient gas' }, { status: 503 });
  }

  const assets: PoolAsset[] = ['BTC', 'ETH', 'SUI'];
  const results: SwapExecutionResult[] = [];
  const hedgedPositions: Array<{ asset: string; usdcValue: number; assetAmount: string; method: string; route: string }> = [];

  // Phase 1: get all forward + reverse quotes in parallel (price discovery)
  const assetQuotes = await Promise.allSettled(
    assets.filter(asset => (allocations[asset] || 0) > 0).map(async (asset) => {
      const pct = (allocations[asset] || 0) / 100;
      const assetUsdValue = withdrawUsdc * pct;
      const forwardQuote = await aggregator.getSwapQuote(asset, assetUsdValue);
      if (!forwardQuote.expectedAmountOut || forwardQuote.expectedAmountOut === '0') {
        return { asset, assetUsdValue, forwardQuote, reverseQuote: null, error: `No price data for ${asset}` };
      }
      const assetAmountRaw = Number(forwardQuote.expectedAmountOut);
      const decimals = asset === 'SUI' ? 9 : 8;
      const assetAmount = assetAmountRaw / Math.pow(10, decimals);
      const reverseQuote = await aggregator.getReverseSwapQuote(asset, assetAmount);
      return { asset, assetUsdValue, forwardQuote, reverseQuote, error: null };
    })
  );

  // Phase 2: execute swaps sequentially (on-chain txs need sequential nonces)
  for (const settled of assetQuotes) {
    if (settled.status !== 'fulfilled' || !settled.value) continue;
    const { asset, assetUsdValue, forwardQuote, reverseQuote, error } = settled.value;

    if (error || !reverseQuote) {
      results.push({ asset, success: false, amountIn: '0', error: error || `No reverse quote for ${asset}` });
      continue;
    }

    if (reverseQuote.canSwapOnChain && reverseQuote.routerData) {
      const execResult = await aggregator.executeSwap(reverseQuote, 0.01);
      results.push(execResult);
      if (execResult.success) {
        await new Promise(r => setTimeout(r, 1500));
      }
    } else if (reverseQuote.hedgeVia === 'bluefin' || forwardQuote.hedgeVia === 'bluefin') {
      const { bluefinService, BluefinService } = await import('@/lib/services/sui/BluefinService');
      const privateKey = (process.env.SUI_POOL_ADMIN_KEY || process.env.BLUEFIN_PRIVATE_KEY || '').trim();
      const bfNetwork = (process.env.BLUEFIN_NETWORK || network || '').trim() as 'mainnet' | 'testnet';

      if (!privateKey) {
        results.push({
          asset,
          success: false,
          amountIn: forwardQuote.expectedAmountOut,
          error: 'BLUEFIN_PRIVATE_KEY not configured — cannot close hedge',
        });
        continue;
      }

      await bluefinService.initialize(privateKey, bfNetwork);
      const symbol = BluefinService.assetToPair(asset);

      if (!symbol) {
        results.push({
          asset,
          success: false,
          amountIn: forwardQuote.expectedAmountOut,
          error: `No BlueFin pair for ${asset}`,
        });
        continue;
      }

      const decimals = asset === 'SUI' ? 9 : 8;
      const closeSize = Number(forwardQuote.expectedAmountOut) / Math.pow(10, decimals);

      const closeResult = await bluefinService.closeHedge({
        symbol,
        size: closeSize > 0 ? closeSize : undefined,
      });

      hedgedPositions.push({
        asset,
        usdcValue: assetUsdValue,
        assetAmount: forwardQuote.expectedAmountOut,
        method: 'bluefin',
        route: reverseQuote.route || `${asset} → USDC (close hedge)`,
      });

      results.push({
        asset,
        success: closeResult.success,
        amountIn: forwardQuote.expectedAmountOut,
        amountOut: Math.floor(assetUsdValue * 1e6).toString(),
        txDigest: closeResult.txDigest,
        error: closeResult.success
          ? `Closed BlueFin hedge: ${symbol}`
          : `BlueFin close failed: ${closeResult.error}`,
      });

      if (closeResult.success) {
        await new Promise(r => setTimeout(r, 1500));
      }
    } else {
      results.push({
        asset,
        success: false,
        amountIn: reverseQuote.amountIn || '0',
        error: `No route for ${asset} → USDC: ${reverseQuote.route}`,
      });
    }
  }

  const totalExecuted = results.filter(r => r.success).length;
  const totalFailed = results.filter(r => !r.success).length;

  logger.info('[SUI-API] Withdrawal swaps executed', {
    withdrawUsdc,
    executed: totalExecuted,
    failed: totalFailed,
    hedged: hedgedPositions.length,
    digests: results.filter(r => r.txDigest).map(r => `${r.asset}:${r.txDigest}`),
  });

  return NextResponse.json({
    success: totalFailed === 0,
    data: {
      executed: totalExecuted,
      failed: totalFailed,
      results: results.map(r => ({
        asset: r.asset,
        success: r.success,
        txDigest: r.txDigest,
        amountIn: r.amountIn,
        amountOut: r.amountOut,
        error: r.error,
      })),
      hedgedPositions: hedgedPositions.length > 0 ? hedgedPositions : undefined,
    },
    chain: 'sui',
  });
}

/**
 * Record a withdrawal the wallet has already made on chain. As with deposits,
 * the body only names the transaction; shares burned and USDC paid come from
 * the event the pool contract emitted.
 */
export async function handleRecordWithdraw(ctx: ActionCtx): Promise<NextResponse> {
  const { network } = ctx;
  const proven = await provePoolTx(ctx, 'UsdcWithdrawn');
  if (proven instanceof NextResponse) return proven;
  const { walletAddress, txDigest, proof } = proven;
  const sharesBurned = proof.shares;
  const usdcReturned = proof.amountUsdc;
  const sharePrice = usdcReturned / sharesBurned;

  const service = getSuiUsdcPoolService(network);
  const { saveUserSharesToDb, deleteUserSharesFromDb, addPoolTransactionToDb, getUserSharesFromDb, txHashExists } = await import('@/lib/db/community-pool');

  return withWalletLock(walletAddress, async () => {
    if (await txHashExists(txDigest)) {
      return NextResponse.json({ success: true, data: { walletAddress, message: 'Transaction already recorded (idempotent)' }, chain: 'sui', network });
    }
    let remainingShares: number;
    let onChainVerified = false;
    try {
      remainingShares = await readMemberSharesStrict(network, walletAddress);
      onChainVerified = true;
    } catch (err) {
      logger.error('[SUI-API] On-chain read failed during withdrawal recording', {
        error: err instanceof Error ? err.message : err,
      });
      const dbShares = await getUserSharesFromDb(walletAddress, 'sui');
      remainingShares = Math.max(0, (dbShares?.shares || 0) - sharesBurned);
    }
    service.clearCaches();

    if (remainingShares <= 0.0001) {
      await deleteUserSharesFromDb(walletAddress, 'sui');
      remainingShares = 0;
    } else {
      // Cost basis at share price, matching how deposits are recorded. It does
      // not track a weighted-average entry.
      await saveUserSharesToDb({
        walletAddress,
        shares: remainingShares,
        costBasisUSD: remainingShares * sharePrice,
        chain: 'sui',
      });
    }

    await addPoolTransactionToDb({
      id: `sui-withdraw-${Date.now()}-${walletAddress.slice(-8)}`,
      type: 'WITHDRAWAL',
      walletAddress,
      amountUSD: usdcReturned,
      shares: sharesBurned,
      sharePrice,
      details: { network, onChain: true, onChainVerified, remainingSharesOnChain: remainingShares },
      txHash: txDigest,
      chain: 'sui',
    });

    logger.info('[SUI-API] Withdrawal recorded', {
      wallet: walletAddress.slice(0, 10) + '...',
      sharesBurned,
      remainingShares,
      onChainVerified,
      txDigest,
    });

    return NextResponse.json({
      success: true,
      data: { walletAddress, sharesBurned, usdcReturned, sharePrice, remainingShares, onChainVerified },
      chain: 'sui',
      network,
    });
  });
}
