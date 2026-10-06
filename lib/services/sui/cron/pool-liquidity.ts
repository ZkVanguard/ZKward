/**
 * Pool-side liquidity — read + top-up orchestrator.
 *
 * `readPoolLiquidityState` unwraps the on-chain balance / hedge-state /
 * daily-cap counters for the pool object.  `ensurePoolLiquidityForWithdraw`
 * is the multi-step orchestrator that top-ups pool USDC before a
 * withdrawal (using the transferUsdcFromPoolToAdmin + returnUsdcToPool
 * primitives and the admin USDC balance guard). Extracted from
 * hedge-treasury.ts on 2026-07-19.
 */
import { logger } from '@/lib/utils/logger';
import {
  SUI_USDC_POOL_CONFIG,
  SUI_USDC_COIN_TYPE,
} from '@/lib/services/sui/SuiCommunityPoolService';
import { returnUsdcToPool } from '@/lib/services/sui/cron/pool-transfer';
import { isPoolTradingEnabled } from '@/lib/services/sui/pool-trading-pause';
import { getAdminUsdcBalance, replenishAdminUsdc } from '@/lib/services/sui/cron/admin-swaps';
import { getActiveHedges } from '@/lib/services/sui/cron/hedge-lifecycle';
import { POOL_ASSETS } from '@/lib/services/sui/cron/allocation'; /**
 * Read pool contract's raw on-chain state relevant to hedge/withdraw sizing.
 * All raw amounts kept as bigint to mirror Move u64 semantics exactly.
 */
export async function readPoolLiquidityState(network: 'mainnet' | 'testnet'): Promise<{
  poolBalanceRaw: bigint;
  externalNavRaw: bigint;
  totalHedgedRaw: bigint;
  totalSharesRaw: bigint;
  onchainNavRaw: bigint;
  totalNavRaw: bigint;
  poolBalanceUsdc: number;
  externalNavUsdc: number;
  totalHedgedUsdc: number;
  onchainNavUsdc: number;
  totalNavUsdc: number;
  maxHedgeRatioBps: number;
  maxSingleWithdrawalBps: number;
  dailyWithdrawalCapBps: number;
  lastHedgeTime: number;
  cooldownMs: number;
  dailyHedgedTodayRaw: bigint;
} | null> {
  const poolConfig = SUI_USDC_POOL_CONFIG[network];
  if (!poolConfig.poolStateId) return null;

  try {
    const { createFailoverSuiClient } = await import('@/lib/services/sui/sui-failover-transport');
    const suiClient = createFailoverSuiClient(network);

    type PoolFields = {
      balance?: string | { fields?: { value?: string }; value?: string };
      hedge_state?: {
        fields?: {
          total_hedged_value?: string;
          current_hedge_day?: string;
          daily_hedge_total?: string;
          auto_hedge_config?: {
            fields?: {
              max_hedge_ratio_bps?: string;
              last_hedge_time?: string;
              cooldown_ms?: string;
            };
          };
        };
      };
      total_shares?: string;
      max_single_withdrawal_bps?: string;
      daily_withdrawal_cap_bps?: string;
    };

    const obj = await suiClient.getObject({
      id: poolConfig.poolStateId!,
      options: { showContent: true },
    });
    const fields = (obj.data?.content as { fields?: PoolFields } | null)?.fields;
    if (!fields) return null;

    const balanceValue =
      typeof fields.balance === 'string'
        ? fields.balance
        : fields.balance?.fields?.value || fields.balance?.value || '0';
    const poolBalanceRaw = BigInt(balanceValue || '0');

    const hedgeState = fields.hedge_state?.fields || {};
    const totalHedgedRaw = BigInt(hedgeState.total_hedged_value || '0');
    const cfg = hedgeState.auto_hedge_config?.fields || {};
    const maxHedgeRatioBps = Number(cfg.max_hedge_ratio_bps || 5000);
    const lastHedgeTime = Number(cfg.last_hedge_time || 0);
    const cooldownMs = Number(cfg.cooldown_ms || 300000);

    const currentDay = Math.floor(Date.now() / 86400000);
    const onChainDay = Number(hedgeState.current_hedge_day || 0);
    const dailyHedgedTodayRaw =
      onChainDay === currentDay ? BigInt(hedgeState.daily_hedge_total || '0') : 0n;

    const totalSharesRaw = BigInt(fields.total_shares || '0');
    const onchainNavRaw = poolBalanceRaw + totalHedgedRaw;

    // External NAV is stored in a dynamic field. Fetch it separately so
    // withdraw sizing matches what calculate_assets_for_shares sees on-chain.
    let externalNavRaw = 0n;
    try {
      const extNavObj = await suiClient.getDynamicFieldObject({
        parentId: poolConfig.poolStateId!,
        name: { type: 'vector<u8>', value: Array.from(Buffer.from('external_nav_usdc')) },
      });
      const extFields = (extNavObj.data?.content as { fields?: { value?: string } } | null)?.fields;
      externalNavRaw = BigInt(extFields?.value || '0');
    } catch {
      externalNavRaw = 0n;
    }
    const totalNavRaw = poolBalanceRaw + externalNavRaw;

    return {
      poolBalanceRaw,
      externalNavRaw,
      totalHedgedRaw,
      totalSharesRaw,
      onchainNavRaw,
      totalNavRaw,
      poolBalanceUsdc: Number(poolBalanceRaw) / 1e6,
      externalNavUsdc: Number(externalNavRaw) / 1e6,
      totalHedgedUsdc: Number(totalHedgedRaw) / 1e6,
      onchainNavUsdc: Number(onchainNavRaw) / 1e6,
      totalNavUsdc: Number(totalNavRaw) / 1e6,
      maxHedgeRatioBps,
      maxSingleWithdrawalBps: Number(fields.max_single_withdrawal_bps || 2500),
      dailyWithdrawalCapBps: Number(fields.daily_withdrawal_cap_bps || 5000),
      lastHedgeTime,
      cooldownMs,
      dailyHedgedTodayRaw,
    };
  } catch (err) {
    logger.warn('[hedge-treasury] readPoolLiquidityState failed', {
      error: err instanceof Error ? err.message : err,
    });
    return null;
  }
}

/**
 * Open a minimal-size operational hedge from the pool to admin, returning the
 * hedge_id emitted by the Move event so the caller can close it in a follow-up
 * transaction. Unlike transferUsdcFromPoolToAdmin(), this variant intentionally
 * BYPASSES the HEDGE_MIN_OPEN_USDC dust guard — the caller is expected to close
 * the hedge in the same operation, netting to a top-up rather than a real hedge.
 */
async function openMicroHedgeAndGetId(
  network: 'mainnet' | 'testnet',
  collateralUsdc: number
): Promise<{ success: boolean; txDigest?: string; hedgeId?: number[]; error?: string }> {
  const adminKey = (process.env.SUI_POOL_ADMIN_KEY || process.env.BLUEFIN_PRIVATE_KEY || '').trim();
  // open_hedge Move signature takes `&AgentCap`, NOT `&AdminCap`. Falling back
  // to SUI_ADMIN_CAP_ID here would produce a runtime TypeMismatch: the cap
  // object types are distinct in the community_pool_usdc module.
  const agentCapId = (process.env.SUI_AGENT_CAP_ID || '').trim();
  const poolConfig = SUI_USDC_POOL_CONFIG[network];

  if (!adminKey) return { success: false, error: 'SUI_POOL_ADMIN_KEY not configured' };
  if (!agentCapId)
    return {
      success: false,
      error:
        'SUI_AGENT_CAP_ID not configured (do NOT fall back to SUI_ADMIN_CAP_ID — Move expects AgentCap, not AdminCap)',
    };
  if (!poolConfig.packageId || !poolConfig.poolStateId) {
    return { success: false, error: 'Pool package or state ID not configured' };
  }
  if (collateralUsdc <= 0) return { success: false, error: 'collateralUsdc must be > 0' };

  try {
    const { Ed25519Keypair } = await import('@mysten/sui/keypairs/ed25519');
    const { Transaction } = await import('@mysten/sui/transactions');
    const { createFailoverSuiClient } = await import('@/lib/services/sui/sui-failover-transport');

    const keypair = adminKey.startsWith('suiprivkey')
      ? Ed25519Keypair.fromSecretKey(adminKey)
      : Ed25519Keypair.fromSecretKey(Buffer.from(adminKey.replace(/^0x/, ''), 'hex'));

    const suiClient = createFailoverSuiClient(network);

    const amountRaw = Math.max(1, Math.floor(collateralUsdc * 1e6));
    const usdcType = SUI_USDC_COIN_TYPE[network];

    const tx = new Transaction();
    tx.moveCall({
      target: `${poolConfig.packageId}::${poolConfig.moduleName}::open_hedge`,
      typeArguments: [usdcType],
      arguments: [
        tx.object(agentCapId),
        tx.object(poolConfig.poolStateId!),
        tx.pure.u8(0), // pair_index=0 (operational rebalance/topup)
        tx.pure.u64(amountRaw),
        tx.pure.u64(1), // leverage=1x
        tx.pure.bool(true),
        tx.pure.string('Withdraw liquidity top-up: pool<->admin USDC transport'),
        tx.object('0x6'),
      ],
    });
    tx.setGasBudget(50_000_000);

    const result = await suiClient.signAndExecuteTransaction({
      transaction: tx,
      signer: keypair,
      options: { showEffects: true, showEvents: true },
    });

    const success = result.effects?.status?.status === 'success';
    if (!success) {
      return {
        success: false,
        txDigest: result.digest,
        error: result.effects?.status?.error || 'open_hedge reverted',
      };
    }

    const evs = (result.events || []) as Array<{
      type: string;
      parsedJson?: Record<string, unknown>;
    }>;
    const opened = evs.find((e) => e.type.endsWith('::UsdcHedgeOpened'));
    const idArr = opened?.parsedJson?.hedge_id;
    if (!Array.isArray(idArr) || idArr.length !== 32) {
      return {
        success: false,
        txDigest: result.digest,
        error: 'open_hedge succeeded but hedge_id event missing',
      };
    }
    return { success: true, txDigest: result.digest, hedgeId: idArr as number[] };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Ensure the pool contract's USDC balance is high enough to satisfy a user
 * withdrawal for `expectedPayoutUsdc`. When the balance is short, orchestrates:
 *
 *   1. (Optional) swap admin's non-USDC assets -> USDC so the admin has enough
 *      to fund the shortfall.
 *   2. open_hedge from pool -> admin, using the LARGEST hedge collateral the
 *      pool ratios allow (bounded by MIN_RESERVE and MAX_HEDGE_RATIO). This
 *      creates a hedge_id we can close.
 *   3. close_hedge with (collateral + shortfall) USDC from admin. Net effect
 *      on state.balance: +shortfall. Pool now has enough USDC to pay the user.
 *
 * Returns { success: true, alreadyLiquid: true } as a no-op when the pool
 * balance is already sufficient — cheap to call before every withdraw.
 */
export async function ensurePoolLiquidityForWithdraw(
  network: 'mainnet' | 'testnet',
  expectedPayoutUsdc: number
): Promise<{
  success: boolean;
  alreadyLiquid?: boolean;
  toppedUpBy?: number;
  openTxDigest?: string;
  closeTxDigest?: string;
  swapDetails?: unknown;
  error?: string;
}> {
  if (!Number.isFinite(expectedPayoutUsdc) || expectedPayoutUsdc <= 0) {
    return { success: false, error: 'expectedPayoutUsdc must be a positive number' };
  }

  // Buffer over the exact payout to survive share-price drift between this
  // preflight and the user's on-chain withdraw. 0.5% relative + $0.001 floor:
  // relative-sizing keeps small pools from over-topping-up while still
  // covering NAV movement during the round-trip.
  const target = expectedPayoutUsdc * 1.005 + 0.001;

  const state = await readPoolLiquidityState(network);
  if (!state) {
    return { success: false, error: 'Failed to read pool liquidity state' };
  }

  // The top-up signs with the admin key and moves USDC into the pool without
  // re-attesting, which misprices shares until the next attestation. While
  // trading is paused only what is already in the pool can be paid out.
  if (!isPoolTradingEnabled()) {
    return state.poolBalanceUsdc >= expectedPayoutUsdc
      ? { success: true, alreadyLiquid: true }
      : { success: false, error: 'Liquidity top-up is paused; only the pool\'s on-chain balance is available right now.' };
  }

  if (state.poolBalanceUsdc >= target) {
    return { success: true, alreadyLiquid: true };
  }

  let shortfall = target - state.poolBalanceUsdc;
  logger.info('[hedge-treasury] Pool short of withdrawal liquidity', {
    poolBalance: state.poolBalanceUsdc.toFixed(6),
    expectedPayout: expectedPayoutUsdc.toFixed(6),
    shortfall: shortfall.toFixed(6),
  });

  // Strategy A (cooldown-free): if there's an active hedge whose collateral
  // the admin can afford to return in a single close_hedge, use that — close
  // has no cooldown check. Move's `close_hedge` requires `coin::value(funds)
  // >= expected_return`, where `expected_return = collateral + pnl` for a
  // profitable settlement. So admin needs to hand over `collateral +
  // shortfall` USDC to net-add `shortfall` to state.balance.
  //
  // Strategy B (fallback): no viable existing hedge, so open a new bridge
  // hedge with a tiny collateral of our choosing, then close it. Pays the
  // cooldown check.
  const activeHedges = await getActiveHedges(network);

  // Compute the largest collateral we can push into open_hedge, bounded by
  // MIN_RESERVE_RATIO_BPS (2000 = 20%) and the state's max_hedge_ratio_bps.
  const MIN_RESERVE_RATIO_BPS = 2000;
  const dailyHedgedTodayUsdc = Number(state.dailyHedgedTodayRaw) / 1e6;
  const maxByReserve =
    state.poolBalanceUsdc - (state.onchainNavUsdc * MIN_RESERVE_RATIO_BPS) / 10000;
  const maxHedgeTotal = (state.onchainNavUsdc * state.maxHedgeRatioBps) / 10000;
  const maxByRatio = Math.max(0, maxHedgeTotal - state.totalHedgedUsdc);
  const maxByDaily = Math.max(0, state.onchainNavUsdc * 0.5 - dailyHedgedTodayUsdc);
  const maxCollateral = Math.min(maxByReserve, maxByRatio, maxByDaily);

  // Read admin USDC once — we'll iterate strategies against this budget.
  let adminUsdc = await getAdminUsdcBalance(network);

  // Score reusable hedges by admin affordability: cheapest collateral first,
  // filtered to ones we can actually pay off (collateral + shortfall ≤ admin).
  const reusableHedges = [...activeHedges]
    .filter((h) => h.hedgeId.length === 32)
    .sort((a, b) => a.collateralUsdc - b.collateralUsdc);
  let reuseTarget: { hedgeId: number[]; collateralUsdc: number } | null = null;
  for (const h of reusableHedges) {
    if (h.collateralUsdc + shortfall <= adminUsdc) {
      reuseTarget = h;
      break;
    }
  }

  // Fallback plan for Strategy B (only relevant if we can't reuse).
  const bridgeCollateral = Math.min(maxCollateral * 0.5, 0.1);
  const canRunStrategyB =
    maxCollateral > 0.000001 && Date.now() >= state.lastHedgeTime + state.cooldownMs;

  // If we can't reuse AND can't open a bridge, try to bring admin USDC up
  // via reverse swaps and re-evaluate reuse (the cheapest existing hedge
  // may become affordable).
  if (!reuseTarget && !canRunStrategyB && reusableHedges.length > 0) {
    const cheapest = reusableHedges[0];
    const usdcNeeded = cheapest.collateralUsdc + shortfall - adminUsdc;
    if (usdcNeeded > 0) {
      try {
        const { getMarketDataService } =
          await import('@/lib/services/market-data/RealMarketDataService');
        const mds = getMarketDataService();
        const prices: Record<string, number> = {};
        for (const a of POOL_ASSETS) {
          try {
            const p = await mds.getTokenPrice(a);
            if (p?.price > 0) prices[a] = p.price;
          } catch {
            /* skip missing prices */
          }
        }
        const swap = await replenishAdminUsdc(network, usdcNeeded, prices);
        logger.info('[hedge-treasury] Replenished admin USDC to afford cheapest existing hedge', {
          hedgeCollateral: cheapest.collateralUsdc.toFixed(6),
          needed: usdcNeeded.toFixed(6),
          swapped: swap.swapped.toFixed(6),
        });
        adminUsdc = await getAdminUsdcBalance(network);
        if (cheapest.collateralUsdc + shortfall <= adminUsdc) {
          reuseTarget = cheapest;
        }
      } catch (err) {
        logger.warn('[hedge-treasury] Reverse-swap for reuse path failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // Last-resort partial mode: reuseTarget is null (admin can't cover
  // collateral+shortfall) AND strategy B blocked. If admin has any USDC
  // above the cheapest collateral, bridge whatever fits — better to inject
  // $17 than to bail on a $30 shortfall. Full withdraws that need capital
  // beyond admin+swap reach are inherently constrained by BlueFin free
  // collateral which lives on the exchange (no direct withdraw path yet);
  // partial bridging surfaces the most we can move today.
  if (!reuseTarget && !canRunStrategyB && reusableHedges.length > 0) {
    const cheapest = reusableHedges[0];
    if (adminUsdc > cheapest.collateralUsdc + 0.01) {
      reuseTarget = cheapest;
      logger.info('[hedge-treasury] Partial-topup path selected — bridging what admin can cover', {
        adminUsdc: adminUsdc.toFixed(4),
        cheapestCollateral: cheapest.collateralUsdc.toFixed(4),
        fullShortfall: shortfall.toFixed(4),
        maxBridgeable: (adminUsdc - cheapest.collateralUsdc).toFixed(4),
      });
    }
  }

  // Nothing viable — surface a clear error.
  if (!reuseTarget && !canRunStrategyB) {
    const cooldownRemainingS = Math.max(
      0,
      Math.ceil((state.lastHedgeTime + state.cooldownMs - Date.now()) / 1000)
    );
    return {
      success: false,
      error:
        reusableHedges.length > 0
          ? `Cannot top up: cheapest existing hedge collateral is $${reusableHedges[0].collateralUsdc.toFixed(4)}, admin has $${adminUsdc.toFixed(4)} (need $${(reusableHedges[0].collateralUsdc + shortfall).toFixed(4)}). Bridge hedge blocked: ${cooldownRemainingS}s cooldown or capacity=$${maxCollateral.toFixed(4)}.`
          : `Cannot top up: no existing hedge to reuse and bridge hedge blocked (${cooldownRemainingS}s cooldown, maxCollateral=$${maxCollateral.toFixed(4)}).`,
    };
  }

  // Ensure admin has enough USDC for the chosen path. If not, reverse-swap.
  const chosenCollateral = reuseTarget ? reuseTarget.collateralUsdc : bridgeCollateral;
  const adminNeedsUsdc = shortfall + chosenCollateral;
  if (adminUsdc < adminNeedsUsdc) {
    const usdcShortfall = adminNeedsUsdc - adminUsdc;
    try {
      const { getMarketDataService } =
        await import('@/lib/services/market-data/RealMarketDataService');
      const mds = getMarketDataService();
      const prices: Record<string, number> = {};
      for (const a of POOL_ASSETS) {
        try {
          const p = await mds.getTokenPrice(a);
          if (p?.price > 0) prices[a] = p.price;
        } catch {
          /* skip missing prices */
        }
      }
      const swap = await replenishAdminUsdc(network, usdcShortfall, prices);
      logger.info('[hedge-treasury] Replenished admin USDC for withdraw top-up', {
        needed: usdcShortfall.toFixed(6),
        swapped: swap.swapped.toFixed(6),
      });
      adminUsdc = await getAdminUsdcBalance(network);
      // If still short, DON'T bail — bridge whatever admin now has. Better
      // to inject $18 than to reject the whole withdraw. Effective shortfall
      // becomes what admin can actually cover after paying the collateral.
      if (adminUsdc < adminNeedsUsdc) {
        const feasibleShortfall = Math.max(0, adminUsdc - chosenCollateral - 0.01);
        if (feasibleShortfall < 0.01) {
          return {
            success: false,
            error: `Admin has $${adminUsdc.toFixed(4)} USDC after swap attempt; needs $${adminNeedsUsdc.toFixed(4)} to top up pool.`,
            swapDetails: swap.details,
          };
        }
        logger.info('[hedge-treasury] Reducing to partial top-up', {
          adminAfterSwap: adminUsdc.toFixed(4),
          fullShortfall: shortfall.toFixed(4),
          feasibleShortfall: feasibleShortfall.toFixed(4),
        });
        shortfall = feasibleShortfall;
      }
    } catch (err) {
      return {
        success: false,
        error: `Failed to swap admin assets -> USDC: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // Execute chosen strategy.
  let hedgeId: number[];
  let openTxDigest: string | undefined;
  let closingCollateral: number;
  if (reuseTarget) {
    hedgeId = reuseTarget.hedgeId;
    closingCollateral = reuseTarget.collateralUsdc;
    logger.info('[hedge-treasury] Reusing existing hedge for top-up (cooldown-free path)', {
      hedgeId: Buffer.from(hedgeId).toString('hex').slice(0, 16),
      collateralUsdc: closingCollateral.toFixed(6),
      activeCount: activeHedges.length,
    });
  } else {
    const openResult = await openMicroHedgeAndGetId(network, bridgeCollateral);
    if (!openResult.success || !openResult.hedgeId) {
      return {
        success: false,
        error: openResult.error || 'open_hedge failed',
        openTxDigest: openResult.txDigest,
      };
    }
    hedgeId = openResult.hedgeId;
    openTxDigest = openResult.txDigest;
    closingCollateral = bridgeCollateral;
    await new Promise((r) => setTimeout(r, 500));
  }

  const returnAmount = closingCollateral + shortfall;
  const closeResult = await returnUsdcToPool(
    network,
    hedgeId,
    returnAmount,
    shortfall, // pnl_usdc — treated as profit accrual back to pool
    true // is_profit
  );

  if (!closeResult.success) {
    return {
      success: false,
      error: reuseTarget
        ? `close_hedge failed on existing hedge: ${closeResult.error || 'unknown'}.`
        : `open_hedge succeeded but close_hedge failed: ${closeResult.error || 'unknown'}. Hedge left open; cron will reconcile.`,
      openTxDigest,
      closeTxDigest: closeResult.txDigest,
    };
  }

  logger.info('[hedge-treasury] Pool topped up for withdrawal', {
    strategy: reuseTarget ? 'A (reuse existing hedge)' : 'B (open new bridge)',
    shortfall: shortfall.toFixed(6),
    closingCollateral: closingCollateral.toFixed(6),
    openTx: openTxDigest,
    closeTx: closeResult.txDigest,
  });

  return {
    success: true,
    toppedUpBy: shortfall,
    openTxDigest,
    closeTxDigest: closeResult.txDigest,
  };
}
