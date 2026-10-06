/**
 * SUI Community Pool API (USDC Deposits, 4-Asset AI-Managed)
 * 
 * Endpoints:
 * - GET  /api/sui/community-pool                          - Get pool summary with 4-asset allocation
 * - GET  /api/sui/community-pool?user=0x...               - Get user's position (USDC-denominated)
 * - GET  /api/sui/community-pool?action=members           - Get all members
 * - GET  /api/sui/community-pool?action=contract          - Get contract info (USDC coin type etc)
 * - GET  /api/sui/community-pool?action=allocation        - Get current 4-asset allocation
 * - GET  /api/sui/community-pool?action=swap-quote        - Get BlueFin aggregator swap quote
 * - GET  /api/sui/community-pool?action=admin-wallet      - Check admin wallet status
 * - GET  /api/sui/community-pool?action=user-position     - Get user position from DB
 * - GET  /api/sui/community-pool?action=treasury-info     - Get treasury address, pending fees, MSafe status
 * - POST /api/sui/community-pool?action=reconcile          - Reconcile on-chain hedges with DB (dry-run by default)
 * - POST /api/sui/community-pool?action=deposit           - Build USDC deposit tx params
 * - POST /api/sui/community-pool?action=withdraw          - Build withdrawal tx params
 * - POST /api/sui/community-pool?action=collect-fees      - Build collect_fees tx params (admin)
 * - POST /api/sui/community-pool?action=set-treasury      - Build set_treasury tx params (admin)
 * - POST /api/sui/community-pool?action=execute-deposit-swaps   - Swap deposited USDC → 4 assets
 * - POST /api/sui/community-pool?action=execute-withdraw-swaps  - Swap assets → USDC for withdrawal
 * - POST /api/sui/community-pool?action=record-deposit    - Record a deposit already made on chain (proved by its transaction)
 * - POST /api/sui/community-pool?action=record-withdraw   - Record a withdrawal already made on chain (proved by its transaction)
 */

import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/utils/logger';
import { getSuiUsdcPoolService, validateSuiMainnetConfig } from '@/lib/services/sui/SuiCommunityPoolService';
import { getBluefinAggregatorService, type PoolAsset } from '@/lib/services/sui/BluefinAggregatorService';
import { readLimiter, mutationLimiter } from '@/lib/security/rate-limiter';
import { fetchActivePoolHedges, type PoolHedge } from '@/lib/services/sui/pool-hedges-fetcher';
import type { NetworkType, ActionCtx } from './handlers/types';
import {
  handleCollectFees,
  handleSetTreasury,
  handleAdminRecover,
  handleTriggerCron,
  handleReconcile,
} from './handlers/admin-actions';
import {
  handleDeposit,
  handleExecuteDepositSwaps,
  handleDryRunDepositSwaps,
  handleRecordDeposit,
} from './handlers/deposit-actions';
import {
  handleWithdraw,
  handleExecuteWithdrawSwaps,
  handleRecordWithdraw,
} from './handlers/withdraw-actions';
import { withOriginCache } from '@/lib/utils/origin-cache';

export const runtime = 'nodejs';
// 60s to give the withdraw preflight room to run its open+close top-up
// round-trip (~8-13s locally, more with Vercel cold-start latency) without
// hitting the serverless timeout. Read-only actions still return in <1s.
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

function getNetwork(request: NextRequest): NetworkType {
  const url = new URL(request.url);
  const network = url.searchParams.get('network')?.trim();
  if (network === 'mainnet' || network === 'testnet') return network;
  // Default to env var, then testnet as safe fallback
  const envNetwork = (process.env.SUI_NETWORK || 'mainnet').trim() as NetworkType;
  return envNetwork === 'mainnet' || envNetwork === 'testnet' ? envNetwork : 'mainnet';
}

/** Reject requests if mainnet config is incomplete */
function requireValidNetwork(network: NetworkType): NextResponse | null {
  if (network !== 'mainnet') return null;
  const missing = validateSuiMainnetConfig();
  if (missing.length > 0) {
    logger.error('[SUI-API] Mainnet config incomplete — blocking request', { missing });
    return NextResponse.json(
      { success: false, error: `Mainnet not configured. Missing: ${missing.join(', ')}` },
      { status: 503 }
    );
  }
  return null;
}

// Pool-wide reads may be served stale while the CDN refreshes them in the
// background: on a quiet site a short stale window expired between visits,
// so nearly every visitor waited ~3.5 s for a rebuild. The views poll, so a
// stale answer is replaced within one interval. Per-user reads and quotes
// keep the short default.
const POOL_WIDE_STALE_S = 86_400;

/** JSON response with CDN cache headers */
function cachedJsonResponse(data: unknown, cdnTtlSeconds: number = 30, staleSeconds: number = cdnTtlSeconds * 2) {
  return NextResponse.json(data, {
    headers: {
      // 'public' prefix is required for Vercel Edge to CDN-cache. Without it,
      // Vercel serves 'max-age=0, must-revalidate' and every request hits origin.
      'Cache-Control': `public, s-maxage=${cdnTtlSeconds}, stale-while-revalidate=${staleSeconds}`,
    },
  });
}

// ============================================================================
// GET Handler
// ============================================================================

async function handleGet(request: NextRequest) {
  // Rate limit
  const limited = readLimiter.check(request);
  if (limited) return limited;

  const startTime = Date.now();
  
  try {
    const url = new URL(request.url);
    const action = url.searchParams.get('action');
    const user = url.searchParams.get('user');
    const network = getNetwork(request);

    // MAINNET SAFETY: Reject if contract addresses not configured
    const configError = requireValidNetwork(network);
    if (configError) return configError;
    
    logger.info('[SUI-API] Request', { action, user, network });
    
    const service = getSuiUsdcPoolService(network);

    // Cache-bust: clear in-memory caches when client requests fresh data (after deposit/withdraw)
    if (url.searchParams.get('nocache') === '1') {
      service.clearCaches();
    }
    
    // Get BlueFin aggregator swap quote
    if (action === 'swap-quote') {
      const asset = (url.searchParams.get('asset') || 'BTC').toUpperCase() as PoolAsset;
      const amountStr = url.searchParams.get('amount') || '100';
      const amount = parseFloat(amountStr);
      
      if (!['BTC', 'ETH', 'SUI', 'CRO'].includes(asset)) {
        return NextResponse.json(
          { success: false, error: 'Invalid asset. Use BTC, ETH, SUI, or CRO' },
          { status: 400 }
        );
      }
      if (isNaN(amount) || amount <= 0 || amount > 1_000_000) {
        return NextResponse.json(
          { success: false, error: 'Invalid amount (1-1000000 USDC)' },
          { status: 400 }
        );
      }

      const aggregator = getBluefinAggregatorService(network);
      const quote = await aggregator.getSwapQuote(asset, amount);

      return cachedJsonResponse({
        success: true,
        data: {
          asset: quote.asset,
          fromCoinType: quote.fromCoinType,
          toCoinType: quote.toCoinType,
          amountInUsdc: (Number(quote.amountIn) / 1e6).toFixed(2),
          expectedAmountOut: quote.expectedAmountOut,
          priceImpact: quote.priceImpact,
          route: quote.route,
          canSwapOnChain: quote.canSwapOnChain,
          isSimulated: quote.isSimulated,
          hedgeVia: quote.hedgeVia,
        },
        chain: 'sui',
        network,
        duration: Date.now() - startTime,
      }, 15);
    }

    // Check admin wallet status (for swap execution readiness)
    if (action === 'admin-wallet') {
      const aggregator = getBluefinAggregatorService(network);
      const wallet = await aggregator.checkAdminWallet();
      return NextResponse.json({
        success: true,
        data: {
          configured: wallet.configured,
          address: wallet.address,
          suiBalance: wallet.suiBalance,
          hasGas: wallet.hasGas,
          gasFloorSui: wallet.gasFloorSui,
          swapsEnabled: wallet.configured && wallet.hasGas,
        },
        chain: 'sui',
      });
    }

    // Get user position from database (for USDC pool)
    if (action === 'user-position') {
      const wallet = url.searchParams.get('wallet');
      if (!wallet || !/^0x[a-fA-F0-9]{64}$/.test(wallet)) {
        return NextResponse.json(
          { success: false, error: 'Valid SUI wallet address required (0x + 64 hex chars)' },
          { status: 400 }
        );
      }

      const { getUserTransactionCounts, saveUserSharesToDb } = await import('@/lib/db/community-pool');
      const txCounts = await getUserTransactionCounts(wallet, 'sui');

      // On-chain is the source of truth — read member position from contract
      let onChainPosition;
      let onChainReadFailed = false;
      try {
        onChainPosition = await service.getMemberPosition(wallet);
      } catch (err) {
        logger.error('[SUI-API] Failed to read on-chain member position', { 
          wallet: wallet.slice(0, 10) + '...', 
          error: err instanceof Error ? err.message : err,
        });
        onChainPosition = null;
        onChainReadFailed = true;
      }

      // If on-chain read failed, return a clear error instead of faking success with zero shares
      if (onChainReadFailed) {
        return NextResponse.json({
          success: false,
          error: 'Failed to read on-chain position — RPC may be unavailable',
          fallback: {
            wallet,
            depositCount: txCounts.depositCount,
            withdrawalCount: txCounts.withdrawalCount,
          },
          chain: 'sui',
          network,
        }, { status: 503 });
      }

      const shares = onChainPosition?.isMember ? onChainPosition.shares : 0;
      const valueUsdc = onChainPosition?.isMember ? onChainPosition.valueUsd : 0;
      const percentage = onChainPosition?.isMember ? onChainPosition.percentage : 0;
      // costBasis tracks actual USDC deposited on-chain (depositedSui field = depositedUsdc for USDC pool)
      const costBasisUsd = onChainPosition?.isMember ? onChainPosition.depositedSui : 0;

      // Sanity check: percentage can never exceed 100, shares can never be negative
      if (shares < 0 || percentage > 100.001 || valueUsdc < 0) {
        logger.error('[SUI-API] SANITY CHECK FAILED on user position', {
          shares, percentage, valueUsdc, wallet: wallet.slice(0, 10) + '...',
        });
        return NextResponse.json(
          { success: false, error: 'On-chain data failed sanity check — please retry' },
          { status: 500 }
        );
      }

      // Sync DB to match on-chain (background, non-blocking for response)
      if (shares > 0) {
        saveUserSharesToDb({
          walletAddress: wallet,
          shares,
          costBasisUSD: costBasisUsd || shares,
          chain: 'sui',
        }).catch(err => logger.warn('[SUI-API] DB sync failed (non-critical)', { 
          error: err instanceof Error ? err.message : err,
        }));
      }

      if (!onChainPosition?.isMember) {
        return NextResponse.json({
          success: true,
          data: {
            isMember: false,
            wallet,
            shares: 0,
            valueUsdc: 0,
            costBasisUsd: 0,
            depositCount: txCounts.depositCount,
            withdrawalCount: txCounts.withdrawalCount,
            percentage: 0,
          },
          chain: 'sui',
          network,
        });
      }

      return NextResponse.json({
        success: true,
        data: {
          isMember: true,
          wallet,
          shares,
          valueUsdc,
          costBasisUsd,
          joinedAt: onChainPosition.joinedAt || null,
          lastActionAt: onChainPosition.lastDepositAt || null,
          depositCount: txCounts.depositCount,
          withdrawalCount: txCounts.withdrawalCount,
          percentage,
        },
        chain: 'sui',
        network,
      });
    }

    // Get contract info
    if (action === 'contract') {
      const info = service.getContractInfo();
      // Also include the deployed SUI-native pool contract info
      const { getSuiCommunityPoolService } = await import('@/lib/services/sui/SuiCommunityPoolService');
      const nativeInfo = getSuiCommunityPoolService(network).getContractInfo();
      
      // Check BlueFin hedging status
      const bluefinConfigured = !!process.env.BLUEFIN_PRIVATE_KEY;
      
      return NextResponse.json({
        success: true,
        data: {
          ...info,
          // If USDC pool not deployed, show native pool contract as deployed reference
          deployedPackageId: info.packageId || nativeInfo.packageId,
          nativePoolPackageId: nativeInfo.packageId,
          nativePoolStateId: nativeInfo.poolStateId,
          hedgeExecutorStateId: bluefinConfigured ? 'bluefin-perps' : undefined,
          bluefinConfigured,
        },
        chain: 'sui',
        network,
      });
    }

    // Get current 4-asset allocation (AI-managed)
    if (action === 'allocation') {
      // Use SuiPoolAgent for dynamic AI allocation when possible
      try {
        const { getSuiPoolAgent } = await import('@/agents/specialized/SuiPoolAgent');
        const agent = getSuiPoolAgent(network);
        const indicators = await agent.analyzeMarket();
        const decision = agent.generateAllocation(indicators);
        
        return NextResponse.json({
          success: true,
          data: {
            allocation: decision.allocations,
            description: '3-asset AI-managed allocation for USDC deposits',
            assets: ['BTC', 'ETH', 'SUI'],
            rebalanceFrequency: 'daily',
            confidence: decision.confidence,
            reasoning: decision.reasoning,
            shouldRebalance: decision.shouldRebalance,
            swappableAssets: decision.swappableAssets,
            hedgedAssets: decision.hedgedAssets,
            riskScore: decision.riskScore,
            source: 'ai-agent',
          },
          chain: 'sui',
          network,
          duration: Date.now() - startTime,
        });
      } catch (err) {
        // Fallback to static allocation if agent fails
        logger.warn('[SUI-API] SuiPoolAgent failed, using static allocation', {
          error: err instanceof Error ? err.message : err,
          stack: err instanceof Error ? err.stack?.split('\n').slice(0, 3).join(' | ') : undefined,
        });
        const allocation = {
          BTC: 35,
          ETH: 30,
          SUI: 35,
        };
        return NextResponse.json({
          success: true,
          data: {
            allocation,
            description: '3-asset AI-managed allocation for USDC deposits',
            assets: ['BTC', 'ETH', 'SUI'],
            rebalanceFrequency: 'daily',
            source: 'static-fallback',
          },
          chain: 'sui',
          network,
          duration: Date.now() - startTime,
        });
      }
    }
    
    // Get all members (cached 2m)
    if (action === 'members') {
      const members = await service.getAllMembers();
      return cachedJsonResponse({
        success: true,
        data: {
          members,
          count: members.length,
        },
        chain: 'sui',
        network,
      }, 60, POOL_WIDE_STALE_S);
    }

    // Volatility context — used by the pool card to give users an honest
    // "24h range" + "30d ago" reference so they don't anchor to ATH and
    // misread normal pullbacks as loss. Read-only aggregate over
    // community_pool_nav_history. Cached 5 minutes.
    if (action === 'volatility') {
      try {
        const { query } = await import('@/lib/db/postgres');
        const [rangeRes, backRes, latestRes, verifiedAthRes] = await Promise.all([
          query<{ min_sp: string; max_sp: string; min_nav: string; max_nav: string }>(
            `SELECT MIN(share_price)::text min_sp, MAX(share_price)::text max_sp,
                    MIN(total_nav)::text min_nav, MAX(total_nav)::text max_nav
             FROM community_pool_nav_history
             WHERE chain = 'sui' AND timestamp >= NOW() - INTERVAL '24 hours'`,
          ),
          query<{ share_price: string; total_nav: string; timestamp: Date }>(
            `SELECT share_price::text, total_nav::text, timestamp
             FROM community_pool_nav_history
             WHERE chain = 'sui' AND timestamp <= NOW() - INTERVAL '30 days'
             ORDER BY timestamp DESC LIMIT 1`,
          ),
          query<{ share_price: string; total_nav: string; timestamp: Date }>(
            `SELECT share_price::text, total_nav::text, timestamp
             FROM community_pool_nav_history
             WHERE chain = 'sui'
             ORDER BY timestamp DESC LIMIT 1`,
          ),
          // Verified ATH — computed from the honest DB record instead of
          // the on-chain all_time_high_nav_per_share which is a
          // monotonically-ratcheting counter. If a jittery NAV snapshot
          // ever spiked (as happened pre-stabilizer), the on-chain ATH
          // baked that phantom permanently. The DB record is what
          // actually persisted, so it's the honest peak. Only trust
          // snapshots the write-time stabilizer approved (source not
          // ending in ':clamped') so we don't reintroduce the same
          // phantom via the DB either.
          query<{ share_price: string; total_nav: string; timestamp: Date }>(
            `SELECT share_price::text, total_nav::text, timestamp
             FROM community_pool_nav_history
             WHERE chain = 'sui'
               AND (source IS NULL OR source NOT LIKE '%:clamped')
             ORDER BY share_price DESC
             LIMIT 1`,
          ),
        ]);
        const range = rangeRes[0];
        const back = backRes[0];
        const latest = latestRes[0];
        const verifiedAth = verifiedAthRes[0];
        return cachedJsonResponse({
          success: true,
          data: {
            range24h: range ? {
              minSharePrice: Number(range.min_sp) || 0,
              maxSharePrice: Number(range.max_sp) || 0,
              minNav: Number(range.min_nav) || 0,
              maxNav: Number(range.max_nav) || 0,
            } : null,
            since30d: back ? {
              sharePrice: Number(back.share_price) || 0,
              nav: Number(back.total_nav) || 0,
              at: back.timestamp,
            } : null,
            latest: latest ? {
              sharePrice: Number(latest.share_price) || 0,
              nav: Number(latest.total_nav) || 0,
              at: latest.timestamp,
            } : null,
            verifiedAth: verifiedAth ? {
              sharePrice: Number(verifiedAth.share_price) || 0,
              nav: Number(verifiedAth.total_nav) || 0,
              at: verifiedAth.timestamp,
            } : null,
          },
          chain: 'sui',
          network,
        }, 300, POOL_WIDE_STALE_S);
      } catch (err) {
        // Non-critical — a missing volatility panel is better than a 500.
        logger.warn('[sui-pool] volatility action failed', { error: err });
        return NextResponse.json({
          success: false,
          error: 'volatility data unavailable',
        }, { status: 200 });
      }
    }
    
    // Get specific user's position — single getPoolStats() call shared
    if (user) {
      const [position, stats] = await Promise.all([
        service.getMemberPosition(user),
        service.getPoolStats(),
      ]);
      
      // Calculate percentage of pool
      const percentage = stats.totalShares > 0 && position.shares > 0
        ? (position.shares / stats.totalShares) * 100
        : 0;
      
      return cachedJsonResponse({
        success: true,
        data: {
          address: position.address,
          shares: position.shares.toFixed(4),
          valueSui: position.valueSui.toFixed(4),
          valueUsd: position.valueUsd.toFixed(2),
          percentage: percentage.toFixed(4),
          joinedAt: position.joinedAt,
          depositedSui: position.depositedSui.toFixed(4),
          withdrawnSui: position.withdrawnSui.toFixed(4),
          isMember: position.isMember,
        },
        pool: {
          totalShares: stats.totalShares.toFixed(4),
          totalNAV: stats.totalNAV.toFixed(4),
          totalNAVUsd: stats.totalNAVUsd.toFixed(2),
          memberCount: stats.memberCount,
          sharePrice: stats.sharePrice.toFixed(6),
        },
        chain: 'sui',
        network,
        duration: Date.now() - startTime,
      }, 15);
    }

    // Treasury info: on-chain treasury address, pending fees, MSafe status
    if (action === 'treasury-info') {
      const treasuryInfo = await service.getTreasuryInfo();
      return cachedJsonResponse({
        success: true,
        data: treasuryInfo,
        chain: 'sui',
        network,
        duration: Date.now() - startTime,
      }, 30, POOL_WIDE_STALE_S);
    }

    // Hedges: active BlueFin perp positions tracked in DB for this pool.
    // The default stats response also embeds this (in a compact form) so
    // the dashboard doesn't need a separate roundtrip.
    if (action === 'hedges') {
      const hedges = await fetchActivePoolHedges();
      return cachedJsonResponse({
        success: true,
        data: { hedges, count: hedges.length },
        chain: 'sui',
        network,
        duration: Date.now() - startTime,
      }, 30, POOL_WIDE_STALE_S);
    }
    
    // Default: Get pool summary (cached 30s) — fetched in parallel with hedges
    // so the dashboard gets the perp positions in the same payload (no extra
    // roundtrip). Hedge fetch failure is non-fatal.
    const [stats, hedges] = await Promise.all([
      service.getPoolStats(),
      fetchActivePoolHedges().catch(() => [] as PoolHedge[]),
    ]);

    // Defense in depth: if the live RPC path yielded a $0 NAV (impossible
    // for a running pool with real deposits — the 2026-07-29 SUI public
    // fullnode JSON-RPC deprecation triggered exactly this), fall back to
    // the last recorded snapshot in community_pool_nav_history so the UI
    // shows the truth-at-a-known-time instead of "$0". Fallback is
    // annotated so the UI can flag it (`stale: true`, `staleAgeSeconds`).
    let displayStats = stats;
    let stale = false;
    let staleAgeSeconds: number | undefined;
    if (network === 'mainnet' && stats.totalNAVUsd < 1) {
      try {
        const { query } = await import('@/lib/db/postgres');
        const rows = await query<{
          total_nav: string;
          share_price: string;
          timestamp: Date;
        }>(
          `SELECT total_nav::text, share_price::text, timestamp
           FROM community_pool_nav_history
           WHERE chain = 'sui'
           ORDER BY timestamp DESC
           LIMIT 1`,
        );
        const latest = rows[0];
        if (latest && Number(latest.total_nav) > 0) {
          const dbNav = Number(latest.total_nav);
          const dbSharePrice = Number(latest.share_price);
          displayStats = {
            ...stats,
            totalNAV: dbNav,
            totalNAVUsd: dbNav,
            sharePrice: dbSharePrice,
            sharePriceUsd: dbSharePrice,
          };
          stale = true;
          staleAgeSeconds = Math.round(
            (Date.now() - new Date(latest.timestamp).getTime()) / 1000,
          );
          logger.warn('[SUI-API] Live RPC returned $0 NAV; served last DB snapshot', {
            dbNav,
            staleAgeSeconds,
          });
        }
      } catch (dbErr) {
        logger.error('[SUI-API] DB fallback failed', { error: dbErr });
      }
    }

    return cachedJsonResponse({
      success: true,
      data: {
        totalShares: displayStats.totalShares.toFixed(4),
        totalNAV: displayStats.totalNAV.toFixed(4),
        totalNAVUsd: displayStats.totalNAVUsd.toFixed(2),
        sharePrice: displayStats.sharePrice.toFixed(6),
        sharePriceUsd: displayStats.sharePriceUsd.toFixed(6),
        allTimeHighNav: displayStats.allTimeHighNav.toFixed(6),
        totalDeposited: (displayStats.totalDeposited ?? 0).toFixed(2),
        totalWithdrawn: (displayStats.totalWithdrawn ?? 0).toFixed(2),
        memberCount: displayStats.memberCount,
        managementFeeBps: displayStats.managementFeeBps,
        performanceFeeBps: displayStats.performanceFeeBps,
        paused: displayStats.paused,
        poolStateId: displayStats.poolStateId,
        allocation: displayStats.allocation,
        hedges,
        stale,
        staleAgeSeconds,
      },
      chain: 'sui',
      network,
      duration: Date.now() - startTime,
    }, stale ? 60 : 30, POOL_WIDE_STALE_S);
    
  } catch (error) {
    logger.error('[SUI-API] Error', { error });
    
    return NextResponse.json(
      {
        success: false,
        error: 'Service temporarily unavailable',
        chain: 'sui',
      },
      { status: 500 }
    );
  }
}


// ============================================================================
// POST Handler — thin dispatcher
// ============================================================================
//
// All action bodies live in ./handlers/{admin,deposit,withdraw}-actions.ts.
// This dispatcher owns only: rate-limiting, network resolution, mainnet
// config guard, and body parse. Extracted 2026-08-10; see git history for
// the pre-split monolith.

export async function POST(request: NextRequest) {
  const limited = mutationLimiter.check(request);
  if (limited) return limited;

  try {
    const url = new URL(request.url);
    const action = url.searchParams.get('action');
    const network = getNetwork(request);

    const configError = requireValidNetwork(network);
    if (configError) return configError;

    const body = await request.json();
    logger.info('[SUI-API] POST request', { action, network, body });

    const ctx: ActionCtx = { request, network, body };

    switch (action) {
      // Admin
      case 'collect-fees':          return handleCollectFees(ctx);
      case 'set-treasury':          return handleSetTreasury(ctx);
      case 'admin-recover':         return handleAdminRecover(ctx);
      case 'trigger-cron':          return handleTriggerCron(ctx);
      case 'reconcile':             return handleReconcile(ctx);
      // Deposit
      case 'deposit':               return handleDeposit(ctx);
      case 'execute-deposit-swaps': return handleExecuteDepositSwaps(ctx);
      case 'dry-run-deposit-swaps': return handleDryRunDepositSwaps(ctx);
      case 'record-deposit':        return handleRecordDeposit(ctx);
      // Withdraw
      case 'withdraw':              return handleWithdraw(ctx);
      case 'execute-withdraw-swaps':return handleExecuteWithdrawSwaps(ctx);
      case 'record-withdraw':       return handleRecordWithdraw(ctx);
      default:
        return NextResponse.json(
          { success: false, error: 'Invalid action. Use deposit, withdraw, execute-deposit-swaps, execute-withdraw-swaps, record-deposit, record-withdraw, or reconcile' },
          { status: 400 },
        );
    }
  } catch (error) {
    logger.error('[SUI-API] POST Error', { error });
    return NextResponse.json(
      { success: false, error: 'Service temporarily unavailable', chain: 'sui' },
      { status: 500 },
    );
  }
}

export const GET = withOriginCache({
  name: 'sui-pool',
  freshSec: 30,
  params: ['network', 'action'],
  eligible: (q) => [null, 'members', 'volatility', 'allocation'].includes(q.get('action')),
}, handleGet);
