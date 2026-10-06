/**
 * Pool ↔ admin USDC transport helpers.
 *
 * These call the SUI Move `open_hedge` and `close_hedge` entries to move
 * USDC between the pool balance and the admin/treasury wallet. Extracted
 * from hedge-treasury.ts on 2026-07-19 so each concern lives in its own
 * focused module.
 *
 * `HEDGE_MIN_OPEN_USDC` owns lives here (only pool-transfer uses it in
 * live code; the string appears in comments elsewhere). Barrel re-exports
 * it for callers that still `import { HEDGE_MIN_OPEN_USDC } from '.../hedge-treasury'`.
 */
import { logger } from '@/lib/utils/logger';
import {
  SUI_USDC_POOL_CONFIG,
  SUI_USDC_COIN_TYPE,
} from '@/lib/services/sui/SuiCommunityPoolService';

/**
 * Minimum USDC value for a meaningful on-chain hedge.
 * Below this, every close emits a deceptive sub-cent "profit" event due to
 * rounding / DEX dust, which clogs the Sui explorer and inflates win-rate stats.
 * Override with HEDGE_MIN_OPEN_USDC env var (decimal USD).
 */
export const HEDGE_MIN_OPEN_USDC = Math.max(
  0.10,
  Number(process.env.HEDGE_MIN_OPEN_USDC) || 0.10,
);


/**
 * Gas budget for an open_hedge or close_hedge call: 0.01 SUI. The node
 * refuses a transaction outright when the wallet holds less than its budget,
 * so at 0.05 these stopped working long before gas was actually short.
 */
const POOL_TX_GAS_BUDGET = 10_000_000;

/**
 * Return USDC from admin wallet back to the pool via close_hedge.
 * This settles active hedges by returning collateral (+ optional PnL) to the pool.
 *
 * The Move contract's close_hedge:
 *  1. Finds the hedge by ID in active_hedges
 *  2. Removes it and decrements total_hedged_value
 *  3. Joins the passed-in Coin<T> into the pool balance
 *
 * This MUST be called after DEX swaps to return any unused USDC to the pool.
 */
export async function returnUsdcToPool(
  network: 'mainnet' | 'testnet',
  hedgeId: number[],
  amountUsdc: number,
  pnlUsdc: number,
  isProfit: boolean,
  /** Exact integers for the call, when the caller derived them from the hedge's on-chain collateral. */
  raw?: { amountRaw: bigint; pnlRaw: bigint },
): Promise<{ success: boolean; txDigest?: string; error?: string }> {
  const adminKey = (process.env.SUI_POOL_ADMIN_KEY || process.env.BLUEFIN_PRIVATE_KEY || '').trim();
  const agentCapId = (process.env.SUI_AGENT_CAP_ID || process.env.SUI_ADMIN_CAP_ID || '').trim();
  const poolConfig = SUI_USDC_POOL_CONFIG[network];

  if (!adminKey || !agentCapId || !poolConfig.packageId || !poolConfig.poolStateId) {
    return { success: false, error: 'Missing admin key, agent cap, or pool config' };
  }

  try {
    const { Ed25519Keypair } = await import('@mysten/sui/keypairs/ed25519');
    const { Transaction } = await import('@mysten/sui/transactions');
    const { createFailoverSuiClient } = await import('@/lib/services/sui/sui-failover-transport');

    let keypair: InstanceType<typeof Ed25519Keypair>;
    try {
      keypair = adminKey.startsWith('suiprivkey')
        ? Ed25519Keypair.fromSecretKey(adminKey)
        : Ed25519Keypair.fromSecretKey(Buffer.from(adminKey.replace(/^0x/, ''), 'hex'));
    } catch {
      return { success: false, error: 'Invalid admin key format' };
    }

    const suiClient = createFailoverSuiClient(network);

    const usdcType = SUI_USDC_COIN_TYPE[network];
    const amountRaw = raw ? Number(raw.amountRaw) : Math.floor(amountUsdc * 1e6);
    const pnlRaw = raw ? Number(raw.pnlRaw) : Math.floor(pnlUsdc * 1e6);

    // Get admin's USDC coins and merge them into a single coin for the return
    const address = keypair.getPublicKey().toSuiAddress();
    const coins = await suiClient.getCoins({ owner: address, coinType: usdcType });

    if (!coins.data || coins.data.length === 0) {
      return { success: false, error: 'Admin has no USDC coins to return' };
    }

    const totalAvailable = coins.data.reduce((sum, c) => sum + Number(c.balance), 0);
    if (totalAvailable < amountRaw) {
      return { success: false, error: `Admin only has ${(totalAvailable / 1e6).toFixed(6)} USDC, need ${amountUsdc}` };
    }

    const tx = new Transaction();

    // Merge all USDC coins into one, then split the exact amount needed
    let primaryCoin: ReturnType<typeof tx.object>;
    if (coins.data.length === 1) {
      primaryCoin = tx.object(coins.data[0].coinObjectId);
    } else {
      // Merge all coins into the first one
      primaryCoin = tx.object(coins.data[0].coinObjectId);
      const mergeCoins = coins.data.slice(1).map(c => tx.object(c.coinObjectId));
      if (mergeCoins.length > 0) {
        tx.mergeCoins(primaryCoin, mergeCoins);
      }
    }

    // Split exact amount to return to pool
    const [returnCoin] = tx.splitCoins(primaryCoin, [amountRaw]);

    tx.moveCall({
      target: `${poolConfig.packageId}::${poolConfig.moduleName}::close_hedge`,
      typeArguments: [usdcType],
      arguments: [
        tx.object(agentCapId),              // AgentCap
        tx.object(poolConfig.poolStateId!), // UsdcPoolState
        tx.pure.vector('u8', hedgeId),      // hedge_id bytes
        tx.pure.u64(pnlRaw),               // pnl_usdc
        tx.pure.bool(isProfit),             // is_profit
        returnCoin,                          // Coin<USDC> to return to pool
        tx.object('0x6'),                   // Clock
      ],
    });

    tx.setGasBudget(POOL_TX_GAS_BUDGET);

    const result = await suiClient.signAndExecuteTransaction({
      transaction: tx,
      signer: keypair,
      options: { showEffects: true, showEvents: true },
    });

    const success = result.effects?.status?.status === 'success';
    if (success) {
      logger.info('[SUI Cron] close_hedge result', {
        success,
        txDigest: result.digest,
        amountUsdc,
        pnlUsdc,
        isProfit,
      });

      // DB sync: mark the corresponding row closed by hedge_id_onchain.
      // This keeps the DB authoritative even when the close came from a
      // background settlement, not the hedge-monitor cron.
      try {
        const hedgeIdHex = Buffer.from(hedgeId).toString('hex');
        const { closeHedgeByOnchainId } = await import('@/lib/db/hedges');
        const realized = isProfit ? pnlUsdc : -pnlUsdc;
        const dbRes = await closeHedgeByOnchainId({
          hedgeIdOnchain: hedgeIdHex,
          realizedPnl: realized,
          status: 'closed',
          closeTxDigest: result.digest,
        });
        if (dbRes.updated === 0) {
          logger.debug('[SUI Cron] close_hedge: no matching DB row (orphan or already closed)', {
            hedgeIdHex: hedgeIdHex.slice(0, 16),
          });
        }
      } catch (dbErr) {
        logger.warn('[SUI Cron] close_hedge DB sync failed (non-fatal)', {
          error: dbErr instanceof Error ? dbErr.message : String(dbErr),
        });
      }
    } else {
      logger.warn('[SUI Cron] close_hedge tx failed', {
        txDigest: result.digest,
        error: result.effects?.status?.error,
        amountUsdc,
        pnlUsdc,
        isProfit,
      });
    }

    return { success, txDigest: result.digest, error: success ? undefined : result.effects?.status?.error };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('[SUI Cron] returnUsdcToPool failed', { error: msg });
    return { success: false, error: msg };
  }
}


/**
 * Transfer USDC from SUI pool contract to admin wallet using open_hedge.
 * The Move contract's open_hedge splits USDC from the pool Balance<T> and
 * sends a Coin<T> to state.treasury (the admin/treasury wallet).
 *
 * Requires: SUI_AGENT_CAP_ID env var (the AgentCap object owned by admin).
 *
 * Returns the tx digest on success, or null if transfer is not possible.
 */
export async function transferUsdcFromPoolToAdmin(
  network: 'mainnet' | 'testnet',
  amountUsdc: number,
): Promise<{ success: boolean; txDigest?: string; error?: string }> {
  const adminKey = (process.env.SUI_POOL_ADMIN_KEY || process.env.BLUEFIN_PRIVATE_KEY || '').trim();
  const agentCapId = (process.env.SUI_AGENT_CAP_ID || process.env.SUI_ADMIN_CAP_ID || '').trim();
  const poolConfig = SUI_USDC_POOL_CONFIG[network];

  if (!adminKey) {
    return { success: false, error: 'SUI_POOL_ADMIN_KEY not configured' };
  }
  if (!agentCapId) {
    return { success: false, error: 'SUI_AGENT_CAP_ID / SUI_ADMIN_CAP_ID not configured — cannot call open_hedge' };
  }
  if (!poolConfig.packageId || !poolConfig.poolStateId) {
    return { success: false, error: 'Pool package or state ID not configured' };
  }

  // Refuse to open dust hedges. They produce noise on the explorer and
  // distort the apparent win-rate without ever moving meaningful capital.
  if (amountUsdc < HEDGE_MIN_OPEN_USDC) {
    return {
      success: false,
      error: `amount $${amountUsdc.toFixed(6)} below HEDGE_MIN_OPEN_USDC=$${HEDGE_MIN_OPEN_USDC.toFixed(2)} — refusing dust open_hedge`,
    };
  }

  try {
    const { Ed25519Keypair } = await import('@mysten/sui/keypairs/ed25519');
    const { Transaction } = await import('@mysten/sui/transactions');
    const { createFailoverSuiClient } = await import('@/lib/services/sui/sui-failover-transport');

    let keypair: InstanceType<typeof Ed25519Keypair>;
    try {
      keypair = adminKey.startsWith('suiprivkey')
        ? Ed25519Keypair.fromSecretKey(adminKey)
        : Ed25519Keypair.fromSecretKey(Buffer.from(adminKey.replace(/^0x/, ''), 'hex'));
    } catch {
      return { success: false, error: 'Invalid SUI_POOL_ADMIN_KEY format' };
    }

    const suiClient = createFailoverSuiClient(network);

    const amountRaw = Math.floor(amountUsdc * 1e6); // USDC has 6 decimals on SUI
    const usdcType = SUI_USDC_COIN_TYPE[network];

    const tx = new Transaction();
    tx.moveCall({
      target: `${poolConfig.packageId}::${poolConfig.moduleName}::open_hedge`,
      typeArguments: [usdcType],
      arguments: [
        tx.object(agentCapId),              // AgentCap
        tx.object(poolConfig.poolStateId!), // UsdcPoolState
        tx.pure.u8(0),                       // pair_index (0 = rebalance)
        tx.pure.u64(amountRaw),             // collateral_usdc
        tx.pure.u64(1),                     // leverage (1x = spot)
        tx.pure.bool(true),                 // is_long (buying assets)
        tx.pure.string('Cron rebalance: transfer USDC from pool to admin for DEX swaps'),
        tx.object('0x6'),                   // Clock
      ],
    });

    tx.setGasBudget(POOL_TX_GAS_BUDGET);

    const result = await suiClient.signAndExecuteTransaction({
      transaction: tx,
      signer: keypair,
      options: { showEffects: true, showEvents: true },
    });

    const success = result.effects?.status?.status === 'success';
    if (success) {
      logger.info('[SUI Cron] Pool → admin USDC transfer via open_hedge', {
        txDigest: result.digest,
        amountUsdc,
      });

      // DB sync: persist a synthetic row so this on-chain hedge is visible
      // to the hedge-monitor and reconciliation. Pulls the hedge_id from the
      // emitted UsdcHedgeOpened event so we can match it on close.
      try {
        const evs = (result.events || []) as Array<{ type: string; parsedJson?: Record<string, unknown> }>;
        const opened = evs.find(e => e.type.endsWith('::UsdcHedgeOpened'));
        const idArr = opened?.parsedJson?.hedge_id;
        if (Array.isArray(idArr) && idArr.length === 32) {
          const hex = Buffer.from(idArr as number[]).toString('hex');
          const { recordSuiOnchainHedge } = await import('@/lib/db/hedges');
          await recordSuiOnchainHedge({
            hedgeIdOnchain: hex,
            collateralUsdc: amountUsdc,
            pairIndex: 0, // cron always opens with pair_index=0 (rebalance)
            isLong: true,
            leverage: 1,
            txDigest: result.digest,
            walletAddress: keypair.getPublicKey().toSuiAddress(),
            reason: 'Cron rebalance: pool → admin USDC transfer',
          });
        }
      } catch (dbErr) {
        logger.warn('[SUI Cron] open_hedge DB sync failed (non-fatal)', {
          error: dbErr instanceof Error ? dbErr.message : String(dbErr),
        });
      }
    } else {
      logger.error('[SUI Cron] Pool → admin USDC transfer failed', {
        txDigest: result.digest,
        error: result.effects?.status?.error,
      });
    }

    return { success, txDigest: result.digest, error: success ? undefined : result.effects?.status?.error };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('[SUI Cron] transferUsdcFromPoolToAdmin failed', { error: msg });
    return { success: false, error: msg };
  }
}
