/**
 * SUI Community Pool Service
 *
 * Provides integration with the SUI Community Pool Move contract for:
 * - Pool state queries
 * - Deposit/withdraw operations
 * - Member position queries
 * - NAV calculations
 *
 * Uses @mysten/sui SDK for blockchain interactions.
 * The SUI community pool service.
 *
 * @see contracts/sui/sources/community_pool.move
 * @see lib/services/CommunityPoolService.ts (EVM equivalent)
 */

import { logger } from '@/lib/utils/logger';
import { getMarketDataService } from '../market-data/RealMarketDataService';
import {
  suiFetchWithTimeout,
  suiCachedFetch,
  invalidateSuiCache,
  SUI_STATS_TTL_MS as SUI_STATS_TTL,
  SUI_MEMBER_TTL_MS as SUI_MEMBER_TTL,
  SUI_MEMBERS_TTL_MS as SUI_MEMBERS_TTL,
} from '@/lib/services/sui/sui-rpc-utils';

// SuiUsdcPoolService class split into its own file 2026-07-25; re-export
// keeps the 7 caller sites unchanged.
export { SuiUsdcPoolService, getSuiUsdcPoolService } from '@/lib/services/sui/SuiUsdcPoolService';

// Re-export all types and configs from the dedicated types module
export {
  SUI_POOL_CONFIG,
  SUI_USDC_COIN_TYPE,
  SUI_USDC_POOL_CONFIG,
  SUI_DECIMALS,
  SHARE_DECIMALS,
  CLOCK_OBJECT_ID,
  safeRawToDecimal,
  safeDecimalToRaw,
  type SuiNetworkType,
  type SuiPoolAllocation,
  type SuiPoolStats,
  type SuiUsdcPoolStats,
  type SuiMemberPosition,
  type SuiAllocation,
  type SuiDepositParams,
  type SuiWithdrawParams,
  type SuiTransactionResult,
  type SuiTreasuryInfo,
} from '@/lib/types/sui-pool-types';

import {
  SUI_POOL_CONFIG,
  SUI_DECIMALS,
  SHARE_DECIMALS,
  CLOCK_OBJECT_ID,
  safeRawToDecimal,
  safeDecimalToRaw,
  type SuiNetworkType,
  type SuiPoolStats,
  type SuiMemberPosition,
  type SuiTreasuryInfo,
} from '@/lib/types/sui-pool-types'; // ============================================
// ============================================
// SUI COMMUNITY POOL SERVICE
// ============================================

export class SuiCommunityPoolService {
  private network: SuiNetworkType;
  private config: (typeof SUI_POOL_CONFIG)[SuiNetworkType];
  private cachedPoolStateId: string | null = null;

  constructor(network: SuiNetworkType = 'mainnet') {
    this.network = network;
    this.config = SUI_POOL_CONFIG[network];

    // MAINNET SAFETY: Validate that required contract addresses are configured
    if (network === 'mainnet') {
      const missing: string[] = [];
      if (!this.config.packageId) missing.push('NEXT_PUBLIC_SUI_MAINNET_PACKAGE_ID');
      if (!this.config.poolStateId) missing.push('NEXT_PUBLIC_SUI_MAINNET_COMMUNITY_POOL_STATE');
      if (missing.length > 0) {
        logger.error('[SuiCommunityPool] MAINNET CONFIG INCOMPLETE — missing env vars', {
          missing,
        });
      }
    }

    logger.info('[SuiCommunityPool] Initialized', { network, packageId: this.config.packageId });
  }

  /** Clear all SUI caches (call after deposit/withdraw) */
  clearCaches(): void {
    invalidateSuiCache();
    logger.info('[SuiCommunityPool] Caches cleared');
  }

  // ============================================
  // POOL STATE DISCOVERY
  // ============================================

  /**
   * Get or discover the pool state ID from PoolCreated events
   */
  async getPoolStateId(): Promise<string | null> {
    if (this.cachedPoolStateId) {
      return this.cachedPoolStateId;
    }

    if (this.config.poolStateId) {
      this.cachedPoolStateId = this.config.poolStateId;
      return this.cachedPoolStateId;
    }

    // Search for PoolCreated event
    try {
      const response = await suiFetchWithTimeout(this.config.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'suix_queryEvents',
          params: [
            {
              MoveEventType: `${this.config.packageId}::${this.config.moduleName}::PoolCreated`,
            },
            null,
            1,
            true,
          ], // descending order, limit 1
        }),
      });

      const data = await response.json();
      const events = data.result?.data || [];

      if (events.length > 0) {
        const event = events[0].parsedJson;
        this.cachedPoolStateId = event?.pool_id;
        logger.info('[SuiCommunityPool] Found pool state ID:', {
          poolStateId: this.cachedPoolStateId,
        });
        return this.cachedPoolStateId;
      }
    } catch (err) {
      logger.error('[SuiCommunityPool] Failed to query pool events:', err);
    }

    return null;
  }

  // ============================================
  // READ OPERATIONS
  // ============================================

  /**
   * Get pool statistics from on-chain state.
   * Cached for 60s with request deduplication.
   */
  async getPoolStats(): Promise<SuiPoolStats> {
    const poolStateId = await this.getPoolStateId();

    const defaultStats: SuiPoolStats = {
      totalNAV: 0,
      totalNAVUsd: 0,
      totalShares: 0,
      sharePrice: 1.0,
      sharePriceUsd: 0,
      memberCount: 0,
      managementFeeBps: 50,
      performanceFeeBps: 1000,
      paused: false,
      allTimeHighNav: 1.0,
      createdAt: 0,
      poolStateId,
    };

    if (!poolStateId) {
      logger.warn('[SuiCommunityPool] No pool state found - pool may need to be created');
      return defaultStats;
    }

    const cacheKey = `sui-pool-stats-${this.network}`;
    return suiCachedFetch(
      cacheKey,
      async () => {
        try {
          const fields = await this.fetchObjectFields(poolStateId);
          if (!fields) return defaultStats;

          // Parse balance - can be direct string or nested Balance<SUI> struct
          const balanceValue =
            typeof fields.balance === 'string'
              ? fields.balance
              : fields.balance?.fields?.value || fields.balance?.value || '0';
          const totalNAV = safeRawToDecimal(balanceValue, SUI_DECIMALS);
          const totalShares = safeRawToDecimal(fields.total_shares || 0, SHARE_DECIMALS);

          // Calculate share price
          const sharePrice = totalShares > 0 ? totalNAV / totalShares : 1.0;

          // MAINNET SANITY CHECK: Reject obviously wrong SUI amounts
          // Max 10B SUI (total supply is ~10B)
          if (totalNAV > 10_000_000_000 || sharePrice > 1_000_000) {
            logger.error('[SuiCommunityPool] SANITY CHECK FAILED', {
              rawBalance: balanceValue,
              totalNAV,
              totalShares,
              sharePrice,
            });
            return defaultStats;
          }

          // Get SUI price for USD conversion
          let suiPrice = 0;
          try {
            const svc = getMarketDataService();
            const priceData = await svc.getTokenPrice('SUI');
            suiPrice = priceData.price;
          } catch (e) {
            logger.warn('[SuiCommunityPool] Failed to fetch SUI price:', { error: e });
          }

          return {
            totalNAV,
            totalNAVUsd: totalNAV * suiPrice,
            totalShares,
            sharePrice,
            sharePriceUsd: sharePrice * suiPrice,
            memberCount: Number(fields.member_count || 0),
            managementFeeBps: Number(fields.management_fee_bps || 50),
            performanceFeeBps: Number(fields.performance_fee_bps || 1000),
            paused: fields.paused || false,
            allTimeHighNav: Number(fields.all_time_high_nav_per_share || 1e9) / 1e9,
            createdAt: Number(fields.created_at || 0),
            poolStateId,
          };
        } catch (err) {
          logger.error('[SuiCommunityPool] Failed to fetch pool stats:', err);
          return defaultStats;
        }
      },
      SUI_STATS_TTL
    );
  }

  /**
   * Get member position from pool state.
   * Cached for 30s with request deduplication.
   */
  async getMemberPosition(address: string): Promise<SuiMemberPosition> {
    const defaultPosition: SuiMemberPosition = {
      address,
      shares: 0,
      depositedSui: 0,
      withdrawnSui: 0,
      joinedAt: 0,
      lastDepositAt: 0,
      highWaterMark: 0,
      valueSui: 0,
      valueUsd: 0,
      percentage: 0,
      isMember: false,
    };

    const poolStateId = await this.getPoolStateId();
    if (!poolStateId) return defaultPosition;

    const cacheKey = `sui-member-${this.network}-${address.toLowerCase()}`;
    return suiCachedFetch(
      cacheKey,
      async () => {
        try {
          const stats = await this.getPoolStats();
          const poolFields = await this.fetchObjectFields(poolStateId);

          if (!poolFields) return defaultPosition;

          // Get members table ID
          const membersTableId = poolFields.members?.fields?.id?.id;
          if (!membersTableId) {
            logger.warn('[SuiCommunityPool] Members table not found');
            return defaultPosition;
          }

          // Query dynamic field for this address
          const response = await suiFetchWithTimeout(this.config.rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'suix_getDynamicFieldObject',
              params: [membersTableId, { type: 'address', value: address }],
            }),
          });

          const data = await response.json();
          const memberFields =
            data.result?.data?.content?.fields?.value?.fields || data.result?.data?.content?.fields;

          if (!memberFields || !memberFields.shares) {
            return defaultPosition; // Member not found
          }

          const shares = safeRawToDecimal(memberFields.shares || 0, SHARE_DECIMALS);
          const valueSui = shares * stats.sharePrice;

          // Get SUI price
          let suiPrice = 0;
          try {
            const svc = getMarketDataService();
            const priceData = await svc.getTokenPrice('SUI');
            suiPrice = priceData.price;
          } catch {
            // Use 0
          }

          return {
            address,
            shares,
            depositedSui: safeRawToDecimal(memberFields.deposited_sui || 0, SUI_DECIMALS),
            withdrawnSui: safeRawToDecimal(memberFields.withdrawn_sui || 0, SUI_DECIMALS),
            joinedAt: Number(memberFields.joined_at || 0),
            lastDepositAt: Number(memberFields.last_deposit_at || 0),
            highWaterMark: safeRawToDecimal(memberFields.high_water_mark || 0, 9),
            valueSui,
            valueUsd: valueSui * suiPrice,
            percentage: stats.totalShares > 0 ? (shares / stats.totalShares) * 100 : 0,
            isMember: shares > 0,
          };
        } catch (err) {
          logger.error('[SuiCommunityPool] Failed to fetch member position:', err);
          return defaultPosition;
        }
      },
      SUI_MEMBER_TTL
    );
  }

  /**
   * Get all members (for leaderboard).
   * Cached for 2m. Parallelized RPC calls.
   */
  async getAllMembers(): Promise<SuiMemberPosition[]> {
    const cacheKey = `sui-all-members-${this.network}`;
    return suiCachedFetch(
      cacheKey,
      async () => {
        const poolStateId = await this.getPoolStateId();
        if (!poolStateId) return [];

        try {
          const stats = await this.getPoolStats();
          const poolFields = await this.fetchObjectFields(poolStateId);

          if (!poolFields) return [];

          const membersTableId = poolFields.members?.fields?.id?.id;
          if (!membersTableId) return [];

          // Get all dynamic fields (members)
          const response = await suiFetchWithTimeout(this.config.rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'suix_getDynamicFields',
              params: [membersTableId, null, 100], // limit 100
            }),
          });

          const data = await response.json();
          const fields = data.result?.data || [];

          // Get SUI price once
          let suiPrice = 0;
          try {
            const svc = getMarketDataService();
            const priceData = await svc.getTokenPrice('SUI');
            suiPrice = priceData.price;
          } catch {
            // Use 0
          }

          // Parallelize member fetches using batched multiGetObjects (reduces N+1 RPC calls)
          const BATCH_SIZE = 10;
          const memberAddresses = fields.map((f: any) => f.name?.value).filter(Boolean) as string[];
          const objectIds = fields.map((f: any) => f.objectId).filter(Boolean) as string[];
          const members: SuiMemberPosition[] = [];

          // Migrated 2026-07-29 from raw `sui_multiGetObjects` JSON-RPC
          // to SuiClient — public fullnode deprecated the raw method
          // name (dashboard was reading $0 as a result).
          const { createFailoverSuiClient } = await import('@/lib/services/sui/sui-failover-transport');
          const rpcClient = createFailoverSuiClient(this.network);

          for (let i = 0; i < objectIds.length; i += BATCH_SIZE) {
            const batchIds = objectIds.slice(i, i + BATCH_SIZE);
            const batchAddrs = memberAddresses.slice(i, i + BATCH_SIZE);
            try {
              const objects = await rpcClient.multiGetObjects({
                ids: batchIds,
                options: { showContent: true },
              });

              for (let j = 0; j < objects.length; j++) {
                const content = objects[j]?.data?.content as
                  | { fields?: Record<string, any> }
                  | null
                  | undefined;
                const memberFields =
                  (content?.fields as any)?.value?.fields ||
                  content?.fields;
                const memberAddress = batchAddrs[j];
                if (memberFields && memberFields.shares) {
                  const shares = safeRawToDecimal(memberFields.shares || 0, SHARE_DECIMALS);
                  const valueSui = shares * stats.sharePrice;

                  if (shares > 0) {
                    members.push({
                      address: memberAddress,
                      shares,
                      depositedSui: safeRawToDecimal(memberFields.deposited_sui || 0, SUI_DECIMALS),
                      withdrawnSui: safeRawToDecimal(memberFields.withdrawn_sui || 0, SUI_DECIMALS),
                      joinedAt: Number(memberFields.joined_at || 0),
                      lastDepositAt: Number(memberFields.last_deposit_at || 0),
                      highWaterMark: safeRawToDecimal(memberFields.high_water_mark || 0, 9),
                      valueSui,
                      valueUsd: valueSui * suiPrice,
                      percentage: stats.totalShares > 0 ? (shares / stats.totalShares) * 100 : 0,
                      isMember: true,
                    });
                  }
                }
              }
            } catch (batchErr) {
              logger.warn(
                '[SuiCommunityPool] Batch member fetch failed, falling back to individual',
                { error: batchErr }
              );
              // Fallback: fetch individually for this batch
              for (const memberAddress of batchAddrs) {
                try {
                  const memberRes = await suiFetchWithTimeout(this.config.rpcUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      jsonrpc: '2.0',
                      id: 1,
                      method: 'suix_getDynamicFieldObject',
                      params: [membersTableId, { type: 'address', value: memberAddress }],
                    }),
                  });
                  const memberData = await memberRes.json();
                  const memberFields =
                    memberData.result?.data?.content?.fields?.value?.fields ||
                    memberData.result?.data?.content?.fields;
                  if (memberFields && memberFields.shares) {
                    const shares = safeRawToDecimal(memberFields.shares || 0, SHARE_DECIMALS);
                    const valueSui = shares * stats.sharePrice;
                    if (shares > 0) {
                      members.push({
                        address: memberAddress,
                        shares,
                        depositedSui: safeRawToDecimal(
                          memberFields.deposited_sui || 0,
                          SUI_DECIMALS
                        ),
                        withdrawnSui: safeRawToDecimal(
                          memberFields.withdrawn_sui || 0,
                          SUI_DECIMALS
                        ),
                        joinedAt: Number(memberFields.joined_at || 0),
                        lastDepositAt: Number(memberFields.last_deposit_at || 0),
                        highWaterMark: safeRawToDecimal(memberFields.high_water_mark || 0, 9),
                        valueSui,
                        valueUsd: valueSui * suiPrice,
                        percentage: stats.totalShares > 0 ? (shares / stats.totalShares) * 100 : 0,
                        isMember: true,
                      });
                    }
                  }
                } catch {
                  /* skip individual member on failure */
                }
              }
            }
          }

          return members.sort((a, b) => b.shares - a.shares);
        } catch (err) {
          logger.error('[SuiCommunityPool] Failed to fetch all members:', err);
          return [];
        }
      },
      SUI_MEMBERS_TTL
    );
  }

  // ============================================
  // TREASURY & FEE OPERATIONS
  // ============================================

  /**
   * Read on-chain treasury info: address, pending fees, fee rates.
   */
  async getTreasuryInfo(): Promise<SuiTreasuryInfo> {
    const poolStateId = await this.getPoolStateId();
    const msafeAddr = (process.env.SUI_MSAFE_ADDRESS || '').trim() || null;

    const defaultInfo: SuiTreasuryInfo = {
      treasuryAddress: '',
      accumulatedManagementFees: 0,
      accumulatedPerformanceFees: 0,
      totalPendingFees: 0,
      lastFeeCollection: 0,
      managementFeeBps: 50,
      performanceFeeBps: 1000,
      msafeConfigured: false,
      msafeAddress: msafeAddr,
    };

    if (!poolStateId) return defaultInfo;

    const fields = await this.fetchObjectFields(poolStateId);
    if (!fields) return defaultInfo;

    const treasuryAddress = fields.treasury || '';
    const accMgmt = safeRawToDecimal(fields.accumulated_management_fees || 0, SUI_DECIMALS);
    const accPerf = safeRawToDecimal(fields.accumulated_performance_fees || 0, SUI_DECIMALS);

    return {
      treasuryAddress,
      accumulatedManagementFees: accMgmt,
      accumulatedPerformanceFees: accPerf,
      totalPendingFees: accMgmt + accPerf,
      lastFeeCollection: Number(fields.last_fee_collection || 0),
      managementFeeBps: Number(fields.management_fee_bps || 50),
      performanceFeeBps: Number(fields.performance_fee_bps || 1000),
      msafeConfigured: !!msafeAddr && msafeAddr === treasuryAddress,
      msafeAddress: msafeAddr,
    };
  }

  /**
   * Build collect_fees transaction params for frontend/admin signing.
   * Requires FeeManagerCap object ID.
   */
  buildCollectFeesParams(): {
    target: string;
    poolStateId: string | null;
    feeManagerCapId: string;
    clockId: string;
  } {
    return {
      target: `${this.config.packageId}::${this.config.moduleName}::collect_fees`,
      poolStateId: this.cachedPoolStateId,
      feeManagerCapId: this.config.feeManagerCapId,
      clockId: CLOCK_OBJECT_ID,
    };
  }

  /**
   * Build set_treasury transaction params for admin signing.
   * Requires AdminCap object ID.
   */
  buildSetTreasuryParams(newTreasuryAddress: string): {
    target: string;
    poolStateId: string | null;
    adminCapId: string;
    newTreasury: string;
    clockId: string;
  } {
    return {
      target: `${this.config.packageId}::${this.config.moduleName}::set_treasury`,
      poolStateId: this.cachedPoolStateId,
      adminCapId: this.config.adminCapId,
      newTreasury: newTreasuryAddress,
      clockId: CLOCK_OBJECT_ID,
    };
  }

  // ============================================
  // TRANSACTION BUILDERS (for frontend signing)
  // ============================================

  /**
   * Build deposit transaction data for frontend
   * Returns the Move call parameters - frontend will construct Transaction
   */
  buildDepositParams(amountSui: number): {
    target: string;
    poolStateId: string | null;
    amountMist: bigint;
    clockId: string;
  } {
    const amountMist = safeDecimalToRaw(amountSui, SUI_DECIMALS);
    return {
      target: `${this.config.packageId}::${this.config.moduleName}::deposit`,
      poolStateId: this.cachedPoolStateId,
      amountMist,
      clockId: CLOCK_OBJECT_ID,
    };
  }

  /**
   * Build withdraw transaction data for frontend
   */
  buildWithdrawParams(sharesToBurn: number): {
    target: string;
    poolStateId: string | null;
    sharesScaled: bigint;
    clockId: string;
  } {
    const sharesScaled = BigInt(Math.floor(sharesToBurn * Math.pow(10, SHARE_DECIMALS)));
    return {
      target: `${this.config.packageId}::${this.config.moduleName}::withdraw`,
      poolStateId: this.cachedPoolStateId,
      sharesScaled,
      clockId: CLOCK_OBJECT_ID,
    };
  }

  /**
   * Build create portfolio transaction (compatible with test interface)
   * Uses rwa_manager module for RWA portfolio management
   */
  buildCreatePortfolioTransaction(params: {
    targetYield: number;
    riskTolerance: number;
    initialDeposit: bigint;
  }): {
    target: string;
    coinAmount: bigint;
    typeArgs: string[];
    arguments: (string | number | bigint)[];
  } {
    const rwaPackageId = '0xb1442796d8593b552c7c27a072043639e3e6615a79ba11b87666d31b42fa283a';
    return {
      target: `${rwaPackageId}::rwa_manager::create_portfolio`,
      coinAmount: params.initialDeposit,
      typeArgs: ['0x2::sui::SUI'],
      arguments: [params.targetYield, params.riskTolerance, params.initialDeposit],
    };
  }

  /**
   * Build deposit transaction (compatible with test interface)
   */
  buildDepositTransaction(params: { portfolioId: string; amount: bigint }): {
    target: string;
    typeArgs: string[];
    arguments: (string | bigint)[];
  } {
    const rwaPackageId = '0xb1442796d8593b552c7c27a072043639e3e6615a79ba11b87666d31b42fa283a';
    return {
      target: `${rwaPackageId}::rwa_manager::deposit`,
      typeArgs: ['0x2::sui::SUI'],
      arguments: [params.portfolioId, params.amount],
    };
  }

  /**
   * Build withdraw transaction (compatible with test interface)
   */
  buildWithdrawTransaction(params: { portfolioId: string; amount: bigint }): {
    target: string;
    typeArgs: string[];
    arguments: (string | bigint)[];
  } {
    const rwaPackageId = '0xb1442796d8593b552c7c27a072043639e3e6615a79ba11b87666d31b42fa283a';
    return {
      target: `${rwaPackageId}::rwa_manager::withdraw`,
      typeArgs: ['0x2::sui::SUI'],
      arguments: [params.portfolioId, params.amount],
    };
  }

  /**
   * Build rebalance transaction (compatible with test interface)
   */
  buildRebalanceTransaction(params: {
    portfolioId: string;
    newAllocations: number[];
    reasoning: string;
  }): {
    target: string;
    typeArgs: string[];
    arguments: (string | number[] | string)[];
  } {
    const rwaPackageId = '0xb1442796d8593b552c7c27a072043639e3e6615a79ba11b87666d31b42fa283a';
    return {
      target: `${rwaPackageId}::rwa_manager::rebalance`,
      typeArgs: [],
      arguments: [params.portfolioId, params.newAllocations, params.reasoning],
    };
  }

  /**
   * Build payment transaction (compatible with test interface)
   */
  buildPaymentTransaction(
    amount: bigint,
    recipient: string,
    invoiceId: string
  ): {
    target: string;
    typeArgs: string[];
    arguments: (string | bigint)[];
  } {
    const rwaPackageId = '0xb1442796d8593b552c7c27a072043639e3e6615a79ba11b87666d31b42fa283a';
    return {
      target: `${rwaPackageId}::payment_router::route_payment`,
      typeArgs: ['0x2::sui::SUI'],
      arguments: [amount, recipient, invoiceId],
    };
  }

  /**
   * Get deployment config (compatible with test interface)
   */
  getDeploymentConfig(): {
    packageId: string;
    rwaManagerState: string;
    network: SuiNetworkType;
  } {
    return {
      packageId: '0xb1442796d8593b552c7c27a072043639e3e6615a79ba11b87666d31b42fa283a',
      rwaManagerState: '0x65638c3c5a5af66c33bf06f57230f8d9972d3a5507138974dce11b1e46e85c97',
      network: this.network,
    };
  }

  // ============================================
  // HELPERS
  // ============================================

  /**
   * Fetch object fields from SUI RPC
   */
  private async fetchObjectFields(objectId: string): Promise<Record<string, any> | null> {
    // Use SuiClient from @mysten/sui/client instead of raw JSON-RPC —
    // see SuiUsdcPoolService.fetchObjectFields for the same migration
    // note. The public fullnode deprecated `sui_getObject` on
    // 2026-07-29 (dashboard was showing $0 as a result); the SDK
    // dispatches to whatever method is current under the hood.
    try {
      const { createFailoverSuiClient } = await import('@/lib/services/sui/sui-failover-transport');
      const client = createFailoverSuiClient(this.network);
      const res = await client.getObject({
        id: objectId,
        options: { showContent: true },
      });
      const content = res.data?.content as { fields?: Record<string, any> } | null | undefined;
      return content?.fields ?? null;
    } catch (error) {
      logger.error('[SuiCommunityPool] Failed to fetch object:', { objectId, error });
      return null;
    }
  }

  /**
   * Get explorer URL for a transaction
   */
  getExplorerUrl(txDigest: string): string {
    return `${this.config.explorerUrl}/tx/${txDigest}`;
  }

  /**
   * Get the contract addresses for frontend
   */
  getContractInfo() {
    return {
      packageId: this.config.packageId,
      moduleName: this.config.moduleName,
      poolStateId: this.cachedPoolStateId,
      adminCapId: this.config.adminCapId,
      feeManagerCapId: this.config.feeManagerCapId,
      network: this.network,
      rpcUrl: this.config.rpcUrl,
      explorerUrl: this.config.explorerUrl,
    };
  }
}

// ============================================
// SINGLETON
// ============================================

/**
 * Validate that all required mainnet environment variables are set.
 * Returns an array of missing variable names (empty = all good).
 */
export function validateSuiMainnetConfig(): string[] {
  const missing: string[] = [];
  const check = (envVar: string, ...fallbacks: string[]) => {
    const hasValue = [envVar, ...fallbacks].some((v) => process.env[v]?.trim());
    if (!hasValue) missing.push(envVar);
  };
  // SUI-native pool — required for basic operation
  check('NEXT_PUBLIC_SUI_MAINNET_PACKAGE_ID', 'NEXT_PUBLIC_SUI_PACKAGE_ID');
  check('NEXT_PUBLIC_SUI_MAINNET_COMMUNITY_POOL_STATE', 'NEXT_PUBLIC_SUI_COMMUNITY_POOL_STATE');
  // USDC pool — optional (not deployed yet, falls back to SUI-native)
  // Admin/fee caps — optional for read-only operations
  return missing;
}

let testnetServiceInstance: SuiCommunityPoolService | null = null;
let mainnetServiceInstance: SuiCommunityPoolService | null = null;

export function getSuiCommunityPoolService(network?: SuiNetworkType): SuiCommunityPoolService {
  const net = (network || process.env.SUI_NETWORK || 'mainnet').trim() as SuiNetworkType;
  if (net === 'mainnet') {
    if (!mainnetServiceInstance) {
      mainnetServiceInstance = new SuiCommunityPoolService('mainnet');
    }
    return mainnetServiceInstance;
  }

  if (!testnetServiceInstance) {
    testnetServiceInstance = new SuiCommunityPoolService('testnet');
  }
  return testnetServiceInstance;
}

