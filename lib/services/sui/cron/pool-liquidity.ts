/**
 * Pool-side liquidity: the on-chain balance, hedge state and daily-cap
 * counters of the pool object, read for withdrawal and hedge sizing.
 * Extracted from hedge-treasury.ts on 2026-07-19.
 */
import { logger } from '@/lib/utils/logger';
import { SUI_USDC_POOL_CONFIG } from '@/lib/services/sui/SuiCommunityPoolService';

/**
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
