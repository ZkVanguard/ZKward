/**
 * On-chain data readers for community pool.
 * 
 * Fetches pool statistics, user positions, and member lists directly
 * from on-chain contracts. Includes caching and deduplication.
 */

import { ethers } from 'ethers';
import { NextResponse } from 'next/server';
import { logger } from '@/lib/utils/logger';
import { POOL_CHAIN_CONFIGS } from '@/lib/contracts/community-pool-config';
import type { ChainConfig, PoolDataCache, UserPositionCache } from './types';
import { getChainConfig, POOL_ABI } from './chain-config';
import { dedupedFetch, getCachedRpc, setCachedRpc, POOL_DATA_TTL, USER_POSITION_TTL, LEADERBOARD_TTL } from './cache';

/**
 * Create a JSON response with CDN cache headers for Vercel Edge Cache.
 *
 *   public       — required by Vercel to enable edge caching. Without
 *                  this prefix Vercel serves as if no-store.
 *   s-maxage     — CDN caches for N seconds (shared cache)
 *   stale-while-revalidate — serves stale while fetching fresh in background
 *
 * Confirmed empirically 2026-09-12: previous shipped version omitted
 * `public,` and Vercel returned every request with `max-age=0,
 * must-revalidate` (no CDN hit). Adding it enables real edge caching.
 */
export function cachedJsonResponse(data: unknown, cdnTtlSeconds: number = 30) {
  return NextResponse.json(data, {
    headers: {
      'Cache-Control': `public, s-maxage=${cdnTtlSeconds}, stale-while-revalidate=${cdnTtlSeconds * 2}`,
    },
  });
}

/**
 * Build the extended allocations object used for DB persistence.
 * DRYs up the repeated pattern in deposit/withdraw/sync/reset handlers.
 */
export function buildAllocationsForDb(poolData: PoolDataCache) {
  const totalNAV = poolData.totalValueUSD;
  return {
    BTC: { 
      percentage: poolData.allocations.BTC?.percentage || 0, 
      valueUSD: totalNAV * (poolData.allocations.BTC?.percentage || 0) / 100,
      amount: 0,
      price: 0,
    },
    ETH: { 
      percentage: poolData.allocations.ETH?.percentage || 0, 
      valueUSD: totalNAV * (poolData.allocations.ETH?.percentage || 0) / 100,
      amount: 0,
      price: 0,
    },
    CRO: { 
      percentage: poolData.allocations.CRO?.percentage || 0, 
      valueUSD: totalNAV * (poolData.allocations.CRO?.percentage || 0) / 100,
      amount: 0,
      price: 0,
    },
    SUI: { 
      percentage: poolData.allocations.SUI?.percentage || 0, 
      valueUSD: totalNAV * (poolData.allocations.SUI?.percentage || 0) / 100,
      amount: 0,
      price: 0,
    },
  };
}

/**
 * Fetch on-chain pool data (SINGLE SOURCE OF TRUTH)
 * 
 * @param chainConfig - Optional chain configuration. If not provided, uses Hedera testnet.
 */
export async function getOnChainPoolData(chainConfig?: ChainConfig): Promise<PoolDataCache | null> {
  const config = chainConfig || getChainConfig();
  const cacheKey = `onchain-pool-${config.chainKey}-${config.network}`;

  // Check in-memory cache first
  const cached = getCachedRpc<PoolDataCache>(cacheKey);
  if (cached) return cached;

  // Hedera path: route through Hedera Mirror Node (official indexer).
  // Faster + higher availability than Hashio public RPC, and doesn't
  // choke on the CONTRACT_REVERT_EXECUTED that getPoolStats throws on
  // uninitialised state.
  if (config.chainKey === 'hedera') {
    try {
      const { readHederaPoolSnapshot } = await import('@/lib/services/hedera/mirror-node');
      const fullChainConfig = POOL_CHAIN_CONFIGS.hedera;
      const networkKey = config.network as 'testnet' | 'mainnet';
      const usdtAddr = fullChainConfig?.contracts?.[networkKey]?.usdt ?? null;
      const network = networkKey === 'mainnet' ? 'mainnet' : 'testnet';
      const snap = await readHederaPoolSnapshot(network, config.poolAddress, usdtAddr);
      if ('ok' in snap && snap.ok) {
        // Hedera SimpleUsdcVault holds USDC 1:1 — no AI allocation on this
        // chain. Reflecting that in the returned allocations so the UI
        // doesn't show a misleading BTC/ETH/SUI/CRO 25% split.
        const allocations: Record<string, { percentage: number }> = {
          USDC: { percentage: 100 },
        };
        const result: PoolDataCache = {
          totalValueUSD: snap.totalNavUsdc,
          totalShares: snap.totalShares,
          sharePrice: snap.sharePrice,
          totalMembers: snap.memberCount,
          allocations,
          onChain: true,
        };
        setCachedRpc(cacheKey, result, POOL_DATA_TTL);
        return result;
      }
      logger.warn('[CommunityPool] Mirror Node returned no snapshot for hedera, falling through to RPC', {
        reason: 'reason' in snap ? snap.reason : 'unknown',
      });
    } catch (mirrorErr) {
      logger.warn('[CommunityPool] Mirror Node read threw, falling through to RPC', {
        error: mirrorErr instanceof Error ? mirrorErr.message : String(mirrorErr),
      });
    }
    // Fall through to the generic RPC path below on Mirror Node failure.
  }

  try {
    const provider = new ethers.JsonRpcProvider(config.rpcUrl);
    const pool = new ethers.Contract(config.poolAddress, POOL_ABI, provider);
    
    // Extended ABI for fallback methods
    const FALLBACK_ABI = [
      'function totalShares() view returns (uint256)',
      'function depositToken() view returns (address)',
    ];
    const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];
    
    let totalShares = 0;
    let totalNAV = 0;
    let sharePrice = 1.0;
    let rawMemberCount = 0;
    let allocations: number[] = []; // Populated from on-chain getPoolStats
    
    // Try getPoolStats first
    try {
      const [stats, memberCount] = await Promise.all([
        pool.getPoolStats(),
        pool.getMemberCount(),
      ]);
      
      totalShares = parseFloat(ethers.formatUnits(stats._totalShares, 18));
      totalNAV = parseFloat(ethers.formatUnits(stats._totalNAV, 6)); // USDC decimals
      // Use the contract's _sharePrice (6 decimals, accounts for virtual offsets)
      sharePrice = parseFloat(ethers.formatUnits(stats._sharePrice, 6));
      rawMemberCount = Number(memberCount);
      allocations = (stats._allocations || [0, 0, 0, 0]).map((a: bigint) => Number(a) / 100);
      
      // MAINNET SANITY CHECK: Reject obviously wrong values
      const MAX_REASONABLE_NAV = 10_000_000_000; // $10B
      const MAX_REASONABLE_SHARE_PRICE = 1_000_000; // $1M per share
      if (totalNAV > MAX_REASONABLE_NAV || sharePrice > MAX_REASONABLE_SHARE_PRICE) {
        logger.error(`[CommunityPool] SANITY CHECK FAILED for ${config.chainKey}`, {
          rawNAV: stats._totalNAV.toString(),
          rawSharePrice: stats._sharePrice.toString(),
          parsedTotalNAV: totalNAV,
          parsedSharePrice: sharePrice,
        });
        return null; // Don't serve obviously wrong data
      }
      
      logger.info(`[CommunityPool] getPoolStats succeeded for ${config.chainKey}`, {
        totalShares, totalNAV, rawMemberCount
      });
    } catch (statsError) {
      // Fallback: Read totalShares and USDT balance directly
      logger.warn(`[CommunityPool] getPoolStats failed for ${config.chainKey}, using fallback`, { 
        error: statsError instanceof Error ? statsError.message.substring(0, 100) : String(statsError)
      });
      
      try {
        const poolFallback = new ethers.Contract(config.poolAddress, FALLBACK_ABI, provider);

        // Get total shares — may still succeed even on an uninitialized
        // pool because it just reads storage.
        try {
          const rawShares = await poolFallback.totalShares();
          totalShares = parseFloat(ethers.formatUnits(rawShares, 18));
        } catch {
          totalShares = 0;
        }

        // Get deposit token (USDT) balance as TVL. Guard against the
        // "USDT not yet deployed on this chain" case where addresses.ts
        // has 0x0000...0000 — a balanceOf call to the zero address
        // errors out on Hashio and used to bubble up as "Unable to
        // retrieve pool data" for the whole route.
        const fullChainConfig = POOL_CHAIN_CONFIGS[config.chainKey];
        const networkKey = config.network as 'testnet' | 'mainnet';
        const usdtAddress = fullChainConfig?.contracts?.[networkKey]?.usdt;
        const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

        if (usdtAddress && usdtAddress !== ZERO_ADDR) {
          try {
            const usdt = new ethers.Contract(usdtAddress, ERC20_ABI, provider);
            const usdtBalance = await usdt.balanceOf(config.poolAddress);
            totalNAV = parseFloat(ethers.formatUnits(usdtBalance, 6));
          } catch {
            totalNAV = 0;
          }
        }

        // ERC-4626-style share price with virtual offsets (1 asset + 1 share).
        const VIRTUAL_ASSETS = 1;
        const VIRTUAL_SHARES = 1;
        sharePrice = (totalNAV + VIRTUAL_ASSETS) / (totalShares + VIRTUAL_SHARES);

        // Member count — best effort, default to 0 (not 1 — a truly
        // uninitialized pool has zero members, not "1 unknown").
        try {
          const mc = await pool.getMemberCount();
          rawMemberCount = Number(mc);
        } catch {
          rawMemberCount = 0;
        }

        logger.info(`[CommunityPool] Fallback succeeded for ${config.chainKey}`, {
          totalShares, totalNAV, sharePrice, rawMemberCount,
          note: usdtAddress === ZERO_ADDR ? 'deposit token not deployed on this chain' : undefined,
        });
      } catch (fallbackError) {
        // Even the fallback couldn't be attempted (RPC dead, address is
        // an EOA, chain unreachable). Return an empty-but-valid pool so
        // the UI can render "0 TVL / 0 members" instead of an error
        // banner — the picker showing Hedera exists to prove the
        // multichain design; an uninitialized pool is a legitimate state.
        logger.warn(`[CommunityPool] Fallback failed for ${config.chainKey}, returning empty pool`, {
          error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
        });
        totalShares = 0;
        totalNAV = 0;
        sharePrice = 1;
        rawMemberCount = 0;
      }
    }
    
    // Simplification: Trust the contract's member count to avoid 
    // N+1 query performance issues. Deduplication should happen 
    // off-chain or via graph indexing if precision is critical.
    const uniqueMemberCount = rawMemberCount;
    
    // Parse allocations from contract (BPS to percentage)
    // allocations array populated from on-chain getPoolStats, empty if unavailable
    const btcAlloc = allocations[0] || 0;
    const ethAlloc = allocations[1] || 0;
    const suiAlloc = allocations[2] || 0;
    const croAlloc = allocations[3] || 0;
    
    // Check if pool has diversified allocations or is holding just USDT
    const hasAllocations = btcAlloc > 0 || ethAlloc > 0 || suiAlloc > 0 || croAlloc > 0;
    
    let allocationResult: Record<string, { percentage: number }>;
    
    if (hasAllocations) {
      // Multi-asset pool: use on-chain target allocations
      allocationResult = {
        BTC: { percentage: btcAlloc },
        ETH: { percentage: ethAlloc },
        SUI: { percentage: suiAlloc },
        CRO: { percentage: croAlloc },
      };
    } else {
      // No allocations set - pool is holding USDT only
      allocationResult = {};
      for (const asset of config.assets) {
        if (asset === 'USDT') {
          allocationResult[asset] = { percentage: 100 };
        } else {
          allocationResult[asset] = { percentage: 0 };
        }
      }
    }
    
    const result: PoolDataCache = {
      totalValueUSD: totalNAV,
      totalShares,
      sharePrice,
      totalMembers: uniqueMemberCount,
      allocations: allocationResult,
      onChain: true,
    };
    
    logger.info(`[CommunityPool] Fetched on-chain data for ${config.chainKey}:${config.network}`, {
      totalValueUSD: result.totalValueUSD,
      totalShares: result.totalShares,
      memberCount: result.totalMembers,
    });
    
    setCachedRpc(cacheKey, result, POOL_DATA_TTL);
    return result;
  } catch (err) {
    logger.error(`[CommunityPool API] On-chain stats error for ${config.chainKey}:`, err);
    return null;
  }
}

/**
 * Fetch on-chain user position (SINGLE SOURCE OF TRUTH)
 * 
 * Queries the chain's contract directly.
 */
export async function getOnChainUserPosition(userAddress: string, chainConfig: ChainConfig = getChainConfig()): Promise<UserPositionCache | null> {
  try {
    // Non-EVM addresses (e.g. SUI 64-hex) cannot be queried against EVM contracts
    if (!/^0x[a-fA-F0-9]{40}$/.test(userAddress)) {
      return null;
    }

    const cacheKey = `user-pos-${chainConfig.chainKey}-${chainConfig.network}-${userAddress.toLowerCase()}`;

    return dedupedFetch<UserPositionCache | null>(
      cacheKey,
      async () => {
        const provider = new ethers.JsonRpcProvider(chainConfig.rpcUrl);

        // Get pool stats for share price calculation
        const poolData = await getOnChainPoolData(chainConfig);
        if (!poolData) return null;

        // Get user's member data. Share decimals vary per chain — Hedera's
        // SimpleUsdcVault stores shares in USDC's 6-decimal space (its
        // fold preserves asset decimals). Other pool contracts
        // use 18. Bail out to per-chain scaling.
        //
        // Hedera Hashio quirk: wrapper functions like `members(address)`
        // revert with CONTRACT_REVERT_EXECUTED. The auto-generated public
        // mapping getter `sharesOf(address)` works cleanly. Route Hedera
        // through it directly, other chains keep the `members()` wrapper
        // that returns 4 fields.
        const shareDecimals = chainConfig.chainKey === 'hedera' ? 6 : 18;
        let sharesRaw: bigint;
        if (chainConfig.chainKey === 'hedera') {
          const vault = new ethers.Contract(
            chainConfig.poolAddress,
            ['function sharesOf(address) view returns (uint256)'],
            provider,
          );
          sharesRaw = await vault.sharesOf(userAddress) as bigint;
        } else {
          const pool = new ethers.Contract(chainConfig.poolAddress, POOL_ABI, provider);
          const memberData = await pool.members(userAddress);
          sharesRaw = memberData.shares as bigint;
        }
        const shares = parseFloat(ethers.formatUnits(sharesRaw, shareDecimals));
        
        if (shares === 0) {
          return {
            walletAddress: userAddress,
            shares: 0,
            valueUSD: 0,
            percentage: 0,
            isMember: false,
            onChain: true,
          };
        }
        
        const valueUSD = shares * poolData.sharePrice;
        const percentage = poolData.totalShares > 0 ? (shares / poolData.totalShares) * 100 : 0;
        
        return {
          walletAddress: userAddress,
          shares,
          valueUSD,
          percentage,
          isMember: true,
          onChain: true,
        };
      },
      USER_POSITION_TTL
    );
  } catch (err) {
    logger.error('[CommunityPool API] On-chain user position error:', err);
    return null;
  }
}

/**
 * Fetch ALL on-chain members and their positions with request deduplication
 * TTL: 120 seconds (expensive query)
 * NOTE: Contract memberList may have duplicate entries - we deduplicate by address
 */
export async function getAllOnChainMembers(chainConfig: ChainConfig = getChainConfig()) {
  // Include chain in cache key to avoid mixing data between chains
  const cacheKey = `all-members-${chainConfig.chainKey}-${chainConfig.network}`;
  
  return dedupedFetch<Array<{
    walletAddress: string;
    shares: number;
    depositedUSD: number;
    joinTime: number;
  }> | null>(
    cacheKey,
    async () => {
      try {
        const provider = new ethers.JsonRpcProvider(chainConfig.rpcUrl);
        const pool = new ethers.Contract(chainConfig.poolAddress, POOL_ABI, provider);
        
        const memberCount = await pool.getMemberCount();
        const count = Number(memberCount);
        logger.info(`[CommunityPool API] On-chain member count (raw) for ${chainConfig.chainKey}: ${count}`);
        
        // Use a Map to deduplicate by address (contract memberList has duplicates)
        // OPTIMIZATION: Batch all member lookups in parallel chunks of 5
        const memberMap = new Map<string, {
          walletAddress: string;
          shares: number;
          depositedUSD: number;
          joinTime: number;
        }>();

        const BATCH_SIZE = 5;
        for (let batchStart = 0; batchStart < count; batchStart += BATCH_SIZE) {
          const batchEnd = Math.min(batchStart + BATCH_SIZE, count);
          const indices = Array.from({ length: batchEnd - batchStart }, (_, k) => batchStart + k);

          // Step 1: Fetch addresses in parallel
          const addrs = await Promise.all(indices.map(i => pool.memberList(i)));

          // Step 2: Filter already-seen, fetch member data in parallel
          const newAddrs = addrs.filter(addr => !memberMap.has(addr.toLowerCase()));
          if (newAddrs.length === 0) continue;

          const memberDatas = await Promise.all(newAddrs.map(addr => pool.members(addr)));

          for (let k = 0; k < newAddrs.length; k++) {
            const normalizedAddr = newAddrs[k].toLowerCase();
            memberMap.set(normalizedAddr, {
              walletAddress: normalizedAddr,
              shares: parseFloat(ethers.formatUnits(memberDatas[k].shares, 18)),
              depositedUSD: parseFloat(ethers.formatUnits(memberDatas[k].depositedUSD, 6)),
              joinTime: Number(memberDatas[k].joinTime),
            });
          }
        }
        
        const members = Array.from(memberMap.values());
        logger.info(`[CommunityPool API] Unique members after deduplication: ${members.length}`);
        
        return members;
      } catch (err) {
        logger.error('[CommunityPool API] Failed to fetch all on-chain members:', err);
        return null;
      }
    },
    LEADERBOARD_TTL
  );
}

/**
 * Find user in on-chain members by searching the member list
 * This handles cases where the user's wallet address checksum differs from on-chain storage
 */
export async function findOnChainMember(userAddress: string, chainConfig: ChainConfig = getChainConfig()) {
  const normalizedUser = userAddress.toLowerCase();
  const members = await getAllOnChainMembers(chainConfig);
  
  if (!members) return null;
  
  const found = members.find(m => m.walletAddress.toLowerCase() === normalizedUser);
  if (found) {
    const onChainPool = await getOnChainPoolData(chainConfig);
    const totalShares = onChainPool?.totalShares || members.reduce((sum, m) => sum + m.shares, 0);
    
    return {
      walletAddress: found.walletAddress,
      shares: found.shares,
      valueUSD: found.depositedUSD, // Use deposited value
      percentage: totalShares > 0 ? (found.shares / totalShares) * 100 : 0,
      isMember: found.shares > 0,
      onChain: true,
    };
  }
  
  return null;
}
