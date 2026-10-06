/**
 * SUI USDC Pool Service — the newer 4-asset AI-managed pool.
 *
 * Split out of SuiCommunityPoolService.ts on 2026-07-25 (the file was
 * 1602 LOC covering two pool contracts + shared RPC utils; sui-rpc-utils
 * extraction landed first, this is the class split).
 *
 * Falls back to SuiCommunityPoolService for the SUI-native pool when
 * USDC pool env is not configured (early-mainnet compatibility).
 *
 * @see contracts/sui/sources/community_pool_usdc.move
 */
import { logger } from '@/lib/utils/logger';
import { composeNavUsdc, computeSharePrice, isNavSane } from '@/lib/services/sui/pool-nav';
import { parseTargetAllocation, computeLiveAllocation } from '@/lib/services/sui/pool-allocation';
import {
  suiFetchWithTimeout,
  suiCachedFetch,
  invalidateSuiCache,
  SUI_STATS_TTL_MS as SUI_STATS_TTL,
  SUI_MEMBER_TTL_MS as SUI_MEMBER_TTL,
} from '@/lib/services/sui/sui-rpc-utils';
import {
  SUI_USDC_POOL_CONFIG,
  CLOCK_OBJECT_ID,
  type SuiNetworkType,
  type SuiUsdcPoolStats,
  type SuiMemberPosition,
  type SuiTreasuryInfo,
} from '@/lib/types/sui-pool-types';
import { SuiCommunityPoolService } from '@/lib/services/sui/SuiCommunityPoolService';

// ============================================
// USDC POOL SERVICE (4-asset AI-managed)
// ============================================

const USDC_DECIMALS = 6;

/**
 * An unpriced holding below this many whole units is ignored when deciding
 * whether NAV is complete: a millionth of a coin is under a dollar for any
 * asset the pool holds, and a few leftover base units must not stop the
 * attestation whenever one price read fails.
 */
const UNPRICED_DUST_UNITS = 1e-6;

export class SuiUsdcPoolService {
  private network: SuiNetworkType;
  private config: (typeof SUI_USDC_POOL_CONFIG)[SuiNetworkType];
  private fallbackService: SuiCommunityPoolService;
  private cachedUsdcPoolStateId: string | null = null;
  private lastGoodMembers: SuiMemberPosition[] | null = null;

  constructor(network: SuiNetworkType = 'mainnet') {
    this.network = network;
    this.config = SUI_USDC_POOL_CONFIG[network];
    // Fallback to SUI-native pool until USDC pool is deployed
    this.fallbackService = new SuiCommunityPoolService(network);

    // MAINNET SAFETY: Validate that USDC pool addresses are configured
    if (network === 'mainnet') {
      const missing: string[] = [];
      if (!this.config.packageId) missing.push('NEXT_PUBLIC_SUI_MAINNET_USDC_POOL_PACKAGE_ID');
      if (!this.config.poolStateId) missing.push('NEXT_PUBLIC_SUI_MAINNET_USDC_POOL_STATE');
      if (missing.length > 0) {
        logger.error('[SuiUsdcPool] MAINNET CONFIG INCOMPLETE — missing env vars', { missing });
      }
    }

    logger.info('[SuiUsdcPool] Initialized', {
      network,
      packageId: this.config.packageId || '(pending deploy)',
    });
  }

  /** Check if USDC pool contract is deployed */
  isDeployed(): boolean {
    return !!this.config.packageId;
  }

  /** Clear all caches */
  clearCaches(): void {
    invalidateSuiCache();
    this.fallbackService.clearCaches();
  }

  /** Get or discover USDC pool state ID */
  async getPoolStateId(): Promise<string | null> {
    if (this.cachedUsdcPoolStateId) return this.cachedUsdcPoolStateId;
    if (this.config.poolStateId) {
      this.cachedUsdcPoolStateId = this.config.poolStateId;
      return this.cachedUsdcPoolStateId;
    }

    // If USDC pool not deployed, no pool state
    if (!this.config.packageId) return null;

    // Search for UsdcPoolCreated event
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
              MoveEventType: `${this.config.packageId}::${this.config.moduleName}::UsdcPoolCreated`,
            },
            null,
            1,
            true,
          ],
        }),
      });
      const data = await response.json();
      const events = data.result?.data || [];
      if (events.length > 0) {
        this.cachedUsdcPoolStateId = events[0].parsedJson?.pool_id;
        return this.cachedUsdcPoolStateId;
      }
    } catch (err) {
      logger.error('[SuiUsdcPool] Failed to query pool events:', err);
    }

    return null;
  }

  /**
   * Get USDC pool stats with 4-asset allocation.
   * Falls back to SUI-native pool if USDC pool not deployed.
   */
  async getPoolStats(): Promise<SuiUsdcPoolStats> {
    // If USDC pool not yet deployed, use SUI-native pool with USD overlay
    if (!this.isDeployed()) {
      return this.getStatsFromFallback();
    }

    const poolStateId = await this.getPoolStateId();
    if (!poolStateId) {
      return this.getStatsFromFallback();
    }

    const cacheKey = `sui-usdc-pool-stats-${this.network}`;
    return suiCachedFetch(
      cacheKey,
      async () => {
        try {
          const fields = await this.fetchObjectFields(poolStateId);
          if (!fields) return this.getStatsFromFallback();

          const balanceValue =
            typeof fields.balance === 'string'
              ? fields.balance
              : fields.balance?.fields?.value || fields.balance?.value || '0';
          const balanceUsdc = Number(balanceValue) / Math.pow(10, USDC_DECIMALS);

          // Include USDC transferred out for hedging/swapping in total NAV.
          // On-chain hedge_state.total_hedged_value tracks collateral sent to admin (at cost basis).
          // Additionally, estimate the current market value of non-USDC assets held by admin wallet.
          // This ensures NAV reflects true economic value, not just the recorded collateral.
          const hedgedRaw = fields.hedge_state?.fields?.total_hedged_value || '0';
          const hedgedUsdc = Number(hedgedRaw) / Math.pow(10, USDC_DECIMALS);

          // Fetch admin wallet asset balances and price them at market rates.
          // The admin wallet holds pool capital that has been hedged/swapped out
          // (cost basis tracked in `hedged_value`, but actual market value can differ).
          //
          // NAV formula: balance_in_pool + admin_usdc + admin_non_usdc_market_value
          // We do NOT add `hedged_value` because that is the *cost basis* of funds
          // already represented by admin's actual on-wallet holdings — adding both
          // would double-count. `hedged_value` is a record-keeping field only.
          let adminAssetValueUsdc = 0;
          let adminUsdcInWallet = 0;
          let usedAdminBalances = false;
          // False when a held asset could not be priced: it is then missing from NAV,
          // and a NAV with a hole in it must not be attested on chain.
          let adminHoldingsPriced = true;
          // Per-asset live composition (USD value held per asset).
          // Drives the dashboard "Current Holdings" chart so it shows the
          // REAL composition, not a hardcoded fallback.
          const assetUsdValue: Record<string, number> = { BTC: 0, ETH: 0, SUI: 0 };
          try {
            const adminKey = (
              process.env.SUI_POOL_ADMIN_KEY ||
              process.env.BLUEFIN_PRIVATE_KEY ||
              ''
            ).trim();
            if (adminKey) {
              const { Ed25519Keypair } = await import('@mysten/sui/keypairs/ed25519');
              const { normalizeStructTag } = await import('@mysten/sui/utils');
              const canon = (t: string): string => {
                try {
                  return normalizeStructTag(t);
                } catch {
                  return t;
                }
              };
              const { MAINNET_COIN_TYPES, ASSET_TO_COIN_KEY, ASSET_DECIMALS } =
                await import('@/lib/types/bluefin-types');
              const { getMarketDataService } =
                await import('@/lib/services/market-data/RealMarketDataService');

              const kp = adminKey.startsWith('suiprivkey')
                ? Ed25519Keypair.fromSecretKey(adminKey)
                : Ed25519Keypair.fromSecretKey(Buffer.from(adminKey.replace(/^0x/, ''), 'hex'));
              const addr = kp.getPublicKey().toSuiAddress();
              const { createFailoverSuiClient } = await import('@/lib/services/sui/sui-failover-transport');
              const tmpClient = createFailoverSuiClient(this.network);
              const allBal = await tmpClient.getAllBalances({ owner: addr });
              const mds = getMarketDataService();

              for (const bal of allBal) {
                const raw = Number(bal.totalBalance);
                if (raw <= 0) continue;
                const balType = canon(bal.coinType);

                // Admin USDC is pool capital (received from open_hedge, awaiting swap or close_hedge)
                if (balType === canon(MAINNET_COIN_TYPES.USDC)) {
                  adminUsdcInWallet += raw / Math.pow(10, USDC_DECIMALS);
                  continue;
                }

                // SUI is treated as gas reserve only (not pool capital) — but if the AI
                // allocation includes SUI as an asset, count it. Reserve 1 SUI for gas.
                if (balType === canon('0x2::sui::SUI')) {
                  const suiAmt = raw / 1e9;
                  const swappable = Math.max(0, suiAmt - 1.0);
                  if (swappable > 0) {
                    const sp = await mds.getTokenPrice('SUI').catch(() => ({ price: 0 }));
                    if (sp.price > 0) {
                      const v = swappable * sp.price;
                      adminAssetValueUsdc += v;
                      assetUsdValue.SUI += v;
                    } else if (swappable >= UNPRICED_DUST_UNITS) {
                      adminHoldingsPriced = false;
                    }
                  }
                  continue;
                }

                const assetEntry = Object.entries(ASSET_TO_COIN_KEY).find(
                  ([, key]) => canon(MAINNET_COIN_TYPES[key]) === balType
                );
                if (!assetEntry) continue;
                const asset = assetEntry[0];
                const decimals = ASSET_DECIMALS[ASSET_TO_COIN_KEY[asset]] || 8;
                const amount = raw / Math.pow(10, decimals);
                const priceData = await mds.getTokenPrice(asset).catch(() => ({ price: 0 }));
                if (priceData.price > 0) {
                  const v = amount * priceData.price;
                  adminAssetValueUsdc += v;
                  if (asset in assetUsdValue) assetUsdValue[asset] += v;
                } else if (amount >= UNPRICED_DUST_UNITS) {
                  adminHoldingsPriced = false;
                }
              }
              usedAdminBalances = true;
              logger.info('[SuiUsdcPool] Admin wallet pool-capital included in NAV', {
                adminUsdcInWallet: adminUsdcInWallet.toFixed(4),
                adminAssetValueUsdc: adminAssetValueUsdc.toFixed(4),
                hedgedRecordedUsdc: hedgedUsdc.toFixed(4),
              });
            }
          } catch (adminErr) {
            logger.warn(
              '[SuiUsdcPool] Could not read admin wallet for NAV — falling back to recorded hedged value',
              { error: adminErr }
            );
          }

          // BlueFin Pro margin bank balance + per-position locked margin + uPnL.
          // Once the cron deposits pool USDC into BlueFin to back perp legs, the
          // funds disappear from the operator's spot wallet — they live in the
          // exchange margin bank instead. Without this read, NAV under-counts
          // by the entire deployed-to-BlueFin amount.
          //
          // All the "live read failed / venue looks empty / cache fallback"
          // logic now lives in `safeBluefinSnapshot`. See bluefin-read-safe.ts
          // for the full failure-mode table.
          // "Expected exposure" check — should the venue have positions?
          // OR together every source we know about:
          //   1. On-chain Move state's hedge_state.active_hedges (catches
          //      operational micro-hedges + future on-chain-only flows).
          //   2. DB hedges table where chain='sui' AND status='active'
          //      (catches venue-only perp hedges like our ETH SHORT,
          //      SUI LONG, BTC SHORT — these don't touch on-chain Move
          //      state but we definitely expect them at the venue).
          // Without the DB check, safeBluefinSnapshot's trust-path-2
          // ("venue empty + on-chain empty = real zero") fires on cold-
          // lambda+empty-venue reads, CACHES 0 as legitimate state,
          // and NAV craters by the BlueFin component until the next
          // good cron tick (~5min, but cache holds 0 for 30min). Caused
          // the 2026-06-22 05:03 NAV-$23.63 incident even after batch 13.
          const onChainHedgedRaw = Number(fields.hedge_state?.fields?.total_hedged_value || 0);
          const onChainActiveCount =
            (fields.hedge_state?.fields?.active_hedges as unknown[] | undefined)?.length ?? 0;
          const onChainHasExposure = onChainHedgedRaw > 0 || onChainActiveCount > 0;

          let dbHasActiveHedges = false;
          try {
            const { query } = await import('@/lib/db/postgres');
            const rows = await query<{ n: string | number }>(
              `SELECT COUNT(*)::text AS n FROM hedges WHERE chain = 'sui' AND status = 'active' AND market LIKE '%-PERP'`
            );
            dbHasActiveHedges = Number(rows[0]?.n ?? 0) > 0;
          } catch {
            /* defensive — if DB read fails, fall back to on-chain only */
          }

          const hasExpectedExposure = onChainHasExposure || dbHasActiveHedges;

          const { safeBluefinSnapshot } = await import('@/lib/services/sui/bluefin-read-safe');
          const bfSnap = await safeBluefinSnapshot({
            network: this.network === 'mainnet' ? 'mainnet' : 'testnet',
            onChainHasExposure: hasExpectedExposure,
          });
          const bluefinValueUsdc = bfSnap.totalValue;
          if (bfSnap.source === 'live') {
            logger.info('[SuiUsdcPool] BlueFin component included in NAV', {
              freeCollateral: bfSnap.free.toFixed(4),
              lockedMargin: bfSnap.lockedMargin.toFixed(4),
              uPnL: bfSnap.upnl.toFixed(4),
              total: bluefinValueUsdc.toFixed(4),
              positions: bfSnap.positionsCount,
            });
          } else if (bfSnap.source === 'cache') {
            logger.warn('[SuiUsdcPool] BlueFin component sourced from cache', {
              total: bluefinValueUsdc.toFixed(4),
              ageMs: bfSnap.ageMs,
              warning: bfSnap.warning,
            });
          } else {
            logger.error('[SuiUsdcPool] BlueFin component unknown — NAV will under-count', {
              warning: bfSnap.warning,
            });
          }

          // If we successfully read admin wallet, use real market value (admin USDC + admin assets).
          // Otherwise fall back to recorded `hedged_value` (cost basis only).
          const offChainPoolCapital = usedAdminBalances
            ? adminUsdcInWallet + adminAssetValueUsdc
            : hedgedUsdc;
          const totalNAVUsdc = composeNavUsdc(balanceUsdc, offChainPoolCapital, bluefinValueUsdc);

          const totalShares = Number(fields.total_shares || 0) / Math.pow(10, USDC_DECIMALS);
          const sharePriceUsdc = computeSharePrice(totalNAVUsdc, totalShares);

          // MAINNET SANITY CHECK: Reject obviously wrong values
          if (!isNavSane(totalNAVUsdc, sharePriceUsdc)) {
            logger.error('[SuiUsdcPool] SANITY CHECK FAILED — values exceed reasonable bounds', {
              rawBalance: balanceValue,
              totalNAVUsdc,
              totalShares,
              sharePriceUsdc,
            });
            return this.getStatsFromFallback();
          }

          // Parse 4-asset allocation from on-chain (AI TARGET, used as fallback only),
          // then compute LIVE composition (market value % of NAV + USDC bucket of
          // idle pool/admin/BlueFin capital). See lib/services/sui/pool-allocation.ts.
          const targetAllocation = parseTargetAllocation(fields.current_allocation?.fields);
          const usdcBucket = balanceUsdc + adminUsdcInWallet + bluefinValueUsdc;
          const allocation = computeLiveAllocation({
            assetUsdValue,
            usdcBucket,
            totalNavUsdc: totalNAVUsdc,
            target: targetAllocation,
          });

          return {
            totalNAV: totalNAVUsdc,
            totalNAVUsd: totalNAVUsdc, // USDC ≈ USD
            totalNAVUsdc,
            totalShares,
            sharePrice: sharePriceUsdc,
            sharePriceUsd: sharePriceUsdc,
            sharePriceUsdc,
            memberCount: Number(fields.member_count || 0),
            managementFeeBps: Number(fields.management_fee_bps || 50),
            performanceFeeBps: Number(fields.performance_fee_bps || 1000),
            paused: fields.paused || false,
            allTimeHighNav: Number(fields.all_time_high_nav_per_share || 1e6) / 1e6,
            totalDeposited: Number(fields.total_deposited || 0) / Math.pow(10, USDC_DECIMALS),
            totalWithdrawn: Number(fields.total_withdrawn || 0) / Math.pow(10, USDC_DECIMALS),
            createdAt: Number(fields.created_at || 0),
            poolStateId,
            allocation,
            isUsdcPool: true,
            navBasis: {
              poolBalanceUsdc: balanceUsdc,
              externalUsdc: offChainPoolCapital + bluefinValueUsdc,
              adminRead: usedAdminBalances && adminHoldingsPriced,
              venueSource: bfSnap.source,
            },
          };
        } catch (err) {
          logger.error('[SuiUsdcPool] Failed to fetch pool stats:', err);
          return this.getStatsFromFallback();
        }
      },
      SUI_STATS_TTL
    );
  }

  /** Get stats from SUI-native pool with USDC overlay */
  private async getStatsFromFallback(): Promise<SuiUsdcPoolStats> {
    const base = await this.fallbackService.getPoolStats();
    return {
      ...base,
      totalNAVUsdc: base.totalNAVUsd,
      sharePriceUsdc: base.sharePriceUsd,
      allocation: { BTC: 30, ETH: 30, SUI: 20, CRO: 20 },
      isUsdcPool: false,
    };
  }

  /** Get member position (USDC-denominated) */
  async getMemberPosition(address: string): Promise<SuiMemberPosition> {
    // Security: Validate SUI address format before wasting an RPC call
    if (!address || !/^0x[a-fA-F0-9]{64}$/.test(address)) {
      logger.warn('[SuiUsdcPool] Invalid address passed to getMemberPosition', {
        address: address?.slice(0, 10),
      });
      return {
        address: address || '',
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
    }

    if (!this.isDeployed()) {
      return this.fallbackService.getMemberPosition(address);
    }

    const poolStateId = await this.getPoolStateId();
    if (!poolStateId) {
      return this.fallbackService.getMemberPosition(address);
    }

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

    const cacheKey = `sui-usdc-member-${this.network}-${address.toLowerCase()}`;
    return suiCachedFetch(
      cacheKey,
      async () => {
        try {
          const stats = await this.getPoolStats();
          const fields = await this.fetchObjectFields(poolStateId!);
          if (!fields) throw new Error('pool object unavailable');

          const membersTableId = fields.members?.fields?.id?.id;
          if (!membersTableId) throw new Error('members table id missing');

          // Through the failover client: the single configured endpoint is
          // rate-limited often enough that members were shown zero shares.
          const { createFailoverSuiClient } = await import('@/lib/services/sui/sui-failover-transport');
          const res = await createFailoverSuiClient(this.network).getDynamicFieldObject({
            parentId: membersTableId,
            name: { type: 'address', value: address },
          });
          // Only "no such entry" means not a member. Any other failure throws,
          // so it is never shown or cached as a zero position.
          if (res.error) {
            if (res.error.code === 'dynamicFieldNotFound') return defaultPosition;
            throw new Error(`member read failed: ${res.error.code}`);
          }
          const content = res.data?.content as { fields?: Record<string, any> } | null | undefined;
          if (!content?.fields) throw new Error('member read failed: no content');
          const memberFields = content.fields.value?.fields || content.fields;

          if (!memberFields?.shares) return defaultPosition;

          const shares = Number(memberFields.shares || 0) / Math.pow(10, USDC_DECIMALS);
          const valueUsdc = shares * stats.sharePriceUsdc;

          return {
            address,
            shares,
            depositedSui: Number(memberFields.deposited_usdc || 0) / Math.pow(10, USDC_DECIMALS),
            withdrawnSui: Number(memberFields.withdrawn_usdc || 0) / Math.pow(10, USDC_DECIMALS),
            joinedAt: Number(memberFields.joined_at || 0),
            lastDepositAt: Number(memberFields.last_deposit_at || 0),
            highWaterMark: Number(memberFields.high_water_mark || 0) / 1e6,
            valueSui: valueUsdc, // In USDC context, valueSui = valueUsdc
            valueUsd: valueUsdc,
            percentage: stats.totalShares > 0 ? (shares / stats.totalShares) * 100 : 0,
            isMember: shares > 0,
          };
        } catch (err) {
          logger.error('[SuiUsdcPool] Failed to fetch member:', err);
          throw err;
        }
      },
      SUI_MEMBER_TTL
    );
  }

  /** Get all members of the USDC pool.
   *
   * The previous implementation delegated to the SUI-native fallback service,
   * which queries the SUI-native pool's members table (different object id +
   * field schema). For USDC mainnet this caused the cron's `syncMembersToDb`
   * step to write the WRONG members to DB (deploy 2026-06-12 found 2 stale
   * SUI-native rows in `community_pool_shares` instead of the 3 real USDC
   * members). Fixed by enumerating the USDC pool's own members table and
   * piggybacking on the already-implemented per-member fetcher.
   */
  async getAllMembers(): Promise<SuiMemberPosition[]> {
    if (!this.isDeployed()) {
      return this.fallbackService.getAllMembers();
    }
    const poolStateId = await this.getPoolStateId();
    if (!poolStateId) return [];

    const cacheKey = `sui-usdc-all-members-${this.network}`;
    try {
      const members = await suiCachedFetch(cacheKey, () => this.readAllMembers(poolStateId), SUI_MEMBER_TTL);
      this.lastGoodMembers = members;
      return members;
    } catch (err) {
      // A failed or partial read is never cached and never presented as the
      // full list: fall back to the last complete one. With none (a fresh
      // instance), fail: an empty list would read as "the pool has no members"
      // and be cached at the CDN as fact.
      logger.error('[SuiUsdcPool] getAllMembers failed', err);
      if (this.lastGoodMembers) return this.lastGoodMembers;
      throw err;
    }
  }

  /**
   * One batched read of the members table. Throws on any RPC error or an
   * incomplete result. The previous version fetched each member in parallel
   * and treated a rate-limited read as "not a member", so under RPC 429s the
   * list silently dropped holders (seen in production: the 91% holder).
   */
  private async readAllMembers(poolStateId: string): Promise<SuiMemberPosition[]> {
    const [stats, fields] = await Promise.all([this.getPoolStats(), this.fetchObjectFields(poolStateId)]);
    if (!fields) throw new Error('pool object unavailable');
    const membersTableId = fields.members?.fields?.id?.id;
    if (!membersTableId) throw new Error('members table id missing');
    const expected = Number(fields.members?.fields?.size ?? 0);

    const rpc = async (method: string, params: unknown[]) => {
      const res = await suiFetchWithTimeout(this.config.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      const json = await res.json();
      if (json.error || json.result === undefined) {
        throw new Error(`${method}: ${json.error?.message ?? 'no result'}`);
      }
      return json.result;
    };

    // 100-row page; the pool's $10k TVL cap keeps the table far below that.
    const page = await rpc('suix_getDynamicFields', [membersTableId, null, 100]);
    const ids: string[] = (page.data || [])
      .map((f: { objectId?: string }) => f.objectId)
      .filter((id: string | undefined): id is string => typeof id === 'string');
    if (ids.length === 0) {
      if (expected > 0) throw new Error('members table read returned no rows');
      return [];
    }

    const objects: Array<{ data?: { content?: { fields?: { name?: unknown; value?: { fields?: Record<string, unknown> } } } } }> =
      await rpc('sui_multiGetObjects', [ids, { showContent: true }]);
    const positions = objects.map((o): SuiMemberPosition => {
      const row = o.data?.content?.fields;
      const m = row?.value?.fields;
      if (!m || typeof row?.name !== 'string') throw new Error('member row unreadable');
      const shares = Number(m.shares || 0) / Math.pow(10, USDC_DECIMALS);
      const valueUsdc = shares * stats.sharePriceUsdc;
      return {
        address: row.name,
        shares,
        depositedSui: Number(m.deposited_usdc || 0) / Math.pow(10, USDC_DECIMALS),
        withdrawnSui: Number(m.withdrawn_usdc || 0) / Math.pow(10, USDC_DECIMALS),
        joinedAt: Number(m.joined_at || 0),
        lastDepositAt: Number(m.last_deposit_at || 0),
        highWaterMark: Number(m.high_water_mark || 0) / 1e6,
        valueSui: valueUsdc,
        valueUsd: valueUsdc,
        percentage: stats.totalShares > 0 ? (shares / stats.totalShares) * 100 : 0,
        isMember: shares > 0,
      };
    });
    if (expected > 0 && expected <= 100 && positions.length !== expected) {
      throw new Error(`members read incomplete: ${positions.length}/${expected}`);
    }
    return positions.filter((pos) => pos.shares > 0);
  }

  /**
   * Build USDC deposit transaction params.
   * The frontend must find a USDC coin object to split.
   */
  buildDepositParams(amountUsdc: number): {
    target: string;
    poolStateId: string | null;
    amountRaw: bigint;
    clockId: string;
    usdcCoinType: string;
    typeArg: string;
  } {
    const amountRaw = BigInt(Math.floor(amountUsdc * Math.pow(10, USDC_DECIMALS)));
    const pkg = this.config.packageId || this.fallbackService.getDeploymentConfig().packageId;
    const mod = this.config.moduleName;

    return {
      target: `${pkg}::${mod}::deposit`,
      poolStateId: this.cachedUsdcPoolStateId || this.config.poolStateId,
      amountRaw,
      clockId: CLOCK_OBJECT_ID,
      usdcCoinType: this.config.usdcCoinType,
      typeArg: this.config.usdcCoinType,
    };
  }

  /** Build USDC withdraw transaction params */
  buildWithdrawParams(sharesToBurn: number): {
    target: string;
    poolStateId: string | null;
    sharesScaled: bigint;
    clockId: string;
    typeArg: string;
  } {
    const sharesScaled = BigInt(Math.floor(sharesToBurn * Math.pow(10, USDC_DECIMALS)));
    const pkg = this.config.packageId || this.fallbackService.getDeploymentConfig().packageId;
    const mod = this.config.moduleName;

    return {
      target: `${pkg}::${mod}::withdraw`,
      poolStateId: this.cachedUsdcPoolStateId || this.config.poolStateId,
      sharesScaled,
      clockId: CLOCK_OBJECT_ID,
      typeArg: this.config.usdcCoinType,
    };
  }

  /** Fetch object fields from SUI RPC */
  private async fetchObjectFields(objectId: string): Promise<Record<string, any> | null> {
    // Use SuiClient from @mysten/sui/client instead of raw JSON-RPC.
    // The public fullnode deprecated the older `sui_getObject` method
    // name (see 2026-07-29 health-check "Method not found" incident);
    // the SDK dispatches to the current method under the hood and
    // handles the migration for us — one place to update if it happens
    // again instead of two hand-rolled fetches.
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
      logger.error('[SuiUsdcPool] Failed to fetch object:', { objectId, error });
      return null;
    }
  }

  /** Get contract info for frontend */
  getContractInfo() {
    return {
      packageId: this.config.packageId,
      moduleName: this.config.moduleName,
      poolStateId: this.cachedUsdcPoolStateId,
      usdcCoinType: this.config.usdcCoinType,
      network: this.network,
      rpcUrl: this.config.rpcUrl,
      explorerUrl: this.config.explorerUrl,
      isUsdcPool: true,
    };
  }

  getExplorerUrl(txDigest: string): string {
    return `${this.config.explorerUrl}/tx/${txDigest}`;
  }

  // ============================================
  // TREASURY & FEE DELEGATION (to native pool service)
  // ============================================

  async getTreasuryInfo(): Promise<SuiTreasuryInfo> {
    return this.fallbackService.getTreasuryInfo();
  }

  buildCollectFeesParams() {
    return this.fallbackService.buildCollectFeesParams();
  }

  buildSetTreasuryParams(newTreasuryAddress: string) {
    return this.fallbackService.buildSetTreasuryParams(newTreasuryAddress);
  }
}

// ============================================
// SINGLETON
// ============================================

// USDC Pool singletons
let testnetUsdcInstance: SuiUsdcPoolService | null = null;
let mainnetUsdcInstance: SuiUsdcPoolService | null = null;

export function getSuiUsdcPoolService(network?: SuiNetworkType): SuiUsdcPoolService {
  const net = (network || process.env.SUI_NETWORK || 'mainnet').trim() as SuiNetworkType;
  if (net === 'mainnet') {
    if (!mainnetUsdcInstance) {
      mainnetUsdcInstance = new SuiUsdcPoolService('mainnet');
    }
    return mainnetUsdcInstance;
  }

  if (!testnetUsdcInstance) {
    testnetUsdcInstance = new SuiUsdcPoolService('testnet');
  }
  return testnetUsdcInstance;
}
