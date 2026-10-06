/**
 * On-chain hedge lifecycle helpers — read active hedges + batch settle.
 *
 * `getActiveHedges` reads the on-chain pool state's `active_hedges` field
 * and unwraps the collateral/pair metadata; `settleActiveHedges` iterates
 * the list and closes each via returnUsdcToPool. Extracted from
 * hedge-treasury.ts on 2026-07-19.
 */
import { logger } from '@/lib/utils/logger';
import { SUI_USDC_POOL_CONFIG } from '@/lib/services/sui/SuiCommunityPoolService';
import { returnUsdcToPool } from '@/lib/services/sui/cron/pool-transfer';
import { closeHedgeArgs, splitProRata } from '@/lib/services/sui/cron/onchain-math';
import { getAdminUsdcBalance } from '@/lib/services/sui/cron/admin-swaps';


/**
 * Read active hedges from on-chain pool state.
 * Returns hedge IDs and collateral amounts for settlement.
 */
export async function getActiveHedges(network: 'mainnet' | 'testnet'): Promise<Array<{
  hedgeId: number[];
  collateralUsdc: number;
  /** The contract's own integer, for arguments the contract checks to the unit. */
  collateralRaw: bigint;
  pairIndex: number;
  openTime: number;
}>> {
  const poolConfig = SUI_USDC_POOL_CONFIG[network];
  if (!poolConfig.poolStateId) return [];

  try {
    const { createFailoverSuiClient } = await import('@/lib/services/sui/sui-failover-transport');
    const suiClient = createFailoverSuiClient(network);

    const obj = await suiClient.getObject({
      id: poolConfig.poolStateId,
      options: { showContent: true },
    });
    const fields = (obj.data?.content as { fields?: Record<string, unknown> } | null)?.fields;
    const hedgeStateRaw = (fields as { hedge_state?: { fields?: { active_hedges?: unknown[] } } } | undefined)?.hedge_state;
    const hedges = hedgeStateRaw?.fields?.active_hedges || [];

    return hedges.map((h) => {
      const hf = (h as { fields?: Record<string, unknown> }).fields || (h as Record<string, unknown>);
      return {
        hedgeId: Array.isArray((hf as Record<string, unknown>).hedge_id)
          ? ((hf as Record<string, unknown>).hedge_id as number[])
          : [],
        collateralUsdc: Number((hf as Record<string, unknown>).collateral_usdc || 0) / 1e6,
        collateralRaw: BigInt(String((hf as Record<string, unknown>).collateral_usdc || 0)),
        pairIndex: Number((hf as Record<string, unknown>).pair_index || 0),
        openTime: Number((hf as Record<string, unknown>).open_time || 0),
      };
    });
  } catch (err) {
    logger.warn('[SUI Cron] Failed to read active hedges', { error: err });
    return [];
  }
}

/**
 * Settle all active hedges by returning USDC from admin wallet to pool.
 * Called after DEX swap execution to ensure pool balance is restored.
 *
 * The amount returned for each hedge = original collateral (no PnL tracking
 * since the pool is USDC-denominated and token positions are held externally).
 */
export async function settleActiveHedges(
  network: 'mainnet' | 'testnet',
): Promise<{ settled: number; failed: number; details: Array<{ hedgeId: string; amount: number; success: boolean; pnl?: number; error?: string }> }> {
  const hedges = await getActiveHedges(network);
  if (hedges.length === 0) {
    logger.info('[SUI Cron] No active hedges to settle');
    return { settled: 0, failed: 0, details: [] };
  }

  // Check admin USDC balance
  const adminUsdc = await getAdminUsdcBalance(network);
  const totalNeeded = hedges.reduce((sum, h) => sum + h.collateralUsdc, 0);

  logger.info('[SUI Cron] Settling active hedges', {
    hedgeCount: hedges.length,
    totalCollateral: totalNeeded.toFixed(6),
    adminUsdc: adminUsdc.toFixed(6),
  });

  const details: Array<{ hedgeId: string; amount: number; success: boolean; pnl?: number; error?: string }> = [];
  let settled = 0;
  let failed = 0;
  let remainingUsdc = adminUsdc;

  // Distribute ALL admin USDC proportionally across hedges.
  // If assets appreciated → pool gets back MORE than collateral (profit).
  // If assets depreciated → pool gets back LESS than collateral (loss).
  //
  // In whole units: the contract checks coin >= collateral ± pnl to the
  // unit. Flooring the return and the pnl separately from decimals left the
  // coin one unit short whenever two hedges shared a shortfall, and every
  // close aborted (and paid gas) until the wallet ran dry on 2026-09-30.
  const shares = splitProRata(BigInt(Math.floor(adminUsdc * 1e6)), hedges.map((h) => h.collateralRaw));
  for (let i = 0; i < hedges.length; i++) {
    const hedge = hedges[i];
    const args = closeHedgeArgs(hedge.collateralRaw, shares[i]);
    const returnAmount = Math.min(Number(args.amountRaw) / 1e6, remainingUsdc);
    if (returnAmount < 0.000001) {
      logger.warn('[SUI Cron] Insufficient admin USDC to settle hedge', {
        needed: hedge.collateralUsdc,
        available: remainingUsdc,
      });
      details.push({
        hedgeId: Buffer.from(hedge.hedgeId).toString('hex').slice(0, 16),
        amount: hedge.collateralUsdc,
        success: false,
        error: 'Insufficient admin USDC',
      });
      failed++;
      continue;
    }

    const pnlAmount = Number(args.pnlRaw) / 1e6;
    const isProfit = args.isProfit;

    const result = await returnUsdcToPool(
      network,
      hedge.hedgeId,
      returnAmount,
      pnlAmount,
      isProfit,
      { amountRaw: args.amountRaw, pnlRaw: args.pnlRaw },
    );

    details.push({
      hedgeId: Buffer.from(hedge.hedgeId).toString('hex').slice(0, 16),
      amount: returnAmount,
      success: result.success,
      pnl: isProfit ? pnlAmount : -pnlAmount,
      error: result.error,
    });

    if (result.success) {
      settled++;
      remainingUsdc -= returnAmount;
      // Small delay between transactions to avoid nonce issues
      await new Promise(r => setTimeout(r, 1500));
    } else {
      failed++;
    }
  }

  logger.info('[SUI Cron] Hedge settlement complete', { settled, failed, totalHedges: hedges.length });
  return { settled, failed, details };
}
