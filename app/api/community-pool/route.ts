/**
 * Community Pool API
 *
 * Endpoints:
 * - GET  /api/community-pool              - Get pool summary
 * - GET  /api/community-pool?user=0x...   - Get user's shares and position
 * - POST /api/community-pool?action=deposit    - Deposit USDC
 * - POST /api/community-pool?action=withdraw   - Withdraw by burning shares
 * - GET  /api/community-pool?action=history    - Get pool transaction history
 * - GET  /api/community-pool?action=leaderboard - Get top shareholders
 *
 * SECURITY: deposit/withdraw require wallet auth. Admin actions require CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { logger } from '@/lib/utils/logger';
import {
  getPoolSummary,
  fetchLivePrices,
  calculatePoolNAV,
} from '@/lib/services/cronos/CommunityPoolService';
import {
  getUserShares,
  getPoolHistory,
  getUserTransactionCounts,
} from '@/lib/storage/community-pool-storage';
import {
  resetNavHistory,
  insertInceptionSnapshot,
  getUserSharesFromDb,
} from '@/lib/db/community-pool';
import { requireAuth } from '@/lib/security/auth-middleware';
import { mutationLimiter, readLimiter } from '@/lib/security/rate-limiter';
import { safeErrorResponse } from '@/lib/security/safe-error';
import { POOL_CHAIN_CONFIGS, getDepositTokenInfo } from '@/lib/contracts/community-pool-config';

// Extracted modules
import { getChainConfig } from '@/lib/community-pool/chain-config';
import {
  getOnChainPoolData,
  getOnChainUserPosition,
  getAllOnChainMembers,
  cachedJsonResponse,
} from '@/lib/community-pool/on-chain-reader';
import {
  handleDeposit,
  handleWithdraw,
  handleSyncFromChain,
  handleDeleteUser,
  handleFullReset,
  type HandlerContext,
} from './post-handlers';

/** Timing-safe cron-secret check — GET admin endpoints. */
function verifyCronSecret(request: NextRequest): boolean {
  const cronSecret = request.headers.get('x-cron-secret');
  const expectedSecret = process.env.CRON_SECRET;
  if (!cronSecret || !expectedSecret) return false;
  if (cronSecret.length !== expectedSecret.length) return false;
  return timingSafeEqual(Buffer.from(cronSecret), Buffer.from(expectedSecret));
}

export const runtime = 'nodejs';
export const maxDuration = 15;
export const dynamic = 'force-dynamic';

/**
 * GET - Fetch pool info
 */
export async function GET(request: NextRequest) {
  // Rate limit read operations
  const limited = readLimiter.check(request);
  if (limited) return limited;

  const searchParams = request.nextUrl.searchParams;
  const action = searchParams.get('action');
  const userAddress = searchParams.get('user');
  const forceOnChain = searchParams.get('source') === 'onchain';

  // Multi-chain support: parse chain and network params
  const chainParam = searchParams.get('chain');
  const networkParam = searchParams.get('network');
  const chainConfig = getChainConfig(chainParam, networkParam);

  // SUI chain requires different handling (not EVM-compatible)
  if (chainConfig.chainKey === 'sui') {
    return NextResponse.json(
      {
        success: false,
        error: 'SUI chain requires the SUI-specific API endpoint',
        hint: 'Use /api/sui/community-pool for SUI chain operations',
      },
      { status: 400 }
    );
  }

  // Paper is a virtual pool — not backed by an on-chain contract. Its
  // data lives in cron_state and is served by /api/paper-trader/status.
  if (chainConfig.chainKey === 'paper') {
    return NextResponse.json(
      {
        success: false,
        error: 'Paper pool has no on-chain contract',
        hint: 'Use /api/paper-trader/status for paper pool data',
      },
      { status: 400 }
    );
  }

  const chainKey = chainConfig.chainKey;

  try {
    // Get user's position
    if (userAddress) {
      // SUI addresses (0x + 64 hex) passed to EVM chains → return empty early
      if (/^0x[a-fA-F0-9]{64}$/.test(userAddress) && (chainConfig.chainKey as string) !== 'sui') {
        return NextResponse.json({
          success: true,
          user: {
            walletAddress: userAddress,
            shares: 0,
            valueUSD: 0,
            percentage: 0,
            isMember: false,
            depositCount: 0,
            withdrawalCount: 0,
          },
          pool: null,
          source: 'none',
          message: 'SUI wallet detected — use /api/sui/community-pool for SUI deposits',
        });
      }

      // Get transaction counts for user (used in multiple responses)
      const txCounts = await getUserTransactionCounts(userAddress);

      // Try DB first (faster for UI) unless forceOnChain
      // DB storage is now chain-aware and works for all chains
      if (!forceOnChain) {
        try {
          const userShares = await getUserSharesFromDb(userAddress, chainKey);
          if (userShares && userShares.shares > 0) {
            const onChainPool = await getOnChainPoolData(chainConfig);
            const poolData = onChainPool || (await getPoolSummary(chainKey));

            return NextResponse.json({
              success: true,
              user: {
                walletAddress: userShares.wallet_address,
                shares: userShares.shares,
                valueUSD: userShares.shares * (poolData?.sharePrice || 1),
                percentage:
                  poolData?.totalShares > 0 ? (userShares.shares / poolData.totalShares) * 100 : 0,
                isMember: true,
                depositCount: txCounts.depositCount,
                withdrawalCount: txCounts.withdrawalCount,
              },
              pool: poolData,
              source: 'db',
            });
          }
        } catch (dbError) {
          logger.warn('[CommunityPool API] DB user lookup failed, falling back to on-chain', {
            error: dbError instanceof Error ? dbError.message : String(dbError),
          });
        }
      }

      // Fallback: Try on-chain via getMemberPosition (use chainConfig for correct chain)
      const onChainUser = await getOnChainUserPosition(userAddress, chainConfig);
      const onChainPool = await getOnChainPoolData(chainConfig);

      // Removed expensive member list iteration fallback.
      // Trusted source is getMemberPosition directly.

      if (onChainUser && onChainUser.shares > 0 && onChainPool) {
        return NextResponse.json({
          success: true,
          user: {
            ...onChainUser,
            depositCount: txCounts.depositCount,
            withdrawalCount: txCounts.withdrawalCount,
          },
          pool: onChainPool,
          source: 'onchain',
        });
      }

      // User not found on-chain with shares > 0
      // Return not a member with on-chain pool data
      if (onChainPool) {
        return NextResponse.json({
          success: true,
          user: {
            walletAddress: userAddress,
            shares: 0,
            valueUSD: 0,
            percentage: 0,
            isMember: false,
            depositCount: txCounts.depositCount,
            withdrawalCount: txCounts.withdrawalCount,
          },
          pool: onChainPool,
          source: 'onchain',
        });
      }

      // Fallback to local storage (only if on-chain fails AND we're on the default chain)
      // Non-default chains (Sepolia, Hedera, etc.) should only use on-chain data
      if (chainKey === 'cronos') {
        try {
          const userShares = await getUserShares(userAddress, chainKey);
          const poolSummary = await getPoolSummary(chainKey);

          if (!userShares) {
            return NextResponse.json({
              success: true,
              user: {
                walletAddress: userAddress,
                shares: 0,
                valueUSD: 0,
                percentage: 0,
                isMember: false,
                depositCount: txCounts.depositCount,
                withdrawalCount: txCounts.withdrawalCount,
              },
              pool: poolSummary,
              source: 'local',
            });
          }

          return NextResponse.json({
            success: true,
            user: {
              walletAddress: userShares.walletAddress,
              shares: userShares.shares,
              valueUSD: userShares.shares * poolSummary.sharePrice,
              percentage: userShares.percentage,
              isMember: true,
              joinedAt: userShares.joinedAt,
              totalDeposited: userShares.deposits.reduce((sum, d) => sum + d.amountUSD, 0),
              totalWithdrawn: userShares.withdrawals.reduce((sum, w) => sum + w.amountUSD, 0),
              depositCount: txCounts.depositCount || userShares.deposits.length,
              withdrawalCount: txCounts.withdrawalCount || userShares.withdrawals.length,
            },
            pool: poolSummary,
            source: 'local',
          });
        } catch (dbError) {
          // Database unavailable - return not found response
          logger.warn('[CommunityPool API] DB fallback failed, user not found on-chain', {
            userAddress,
          });
        }
      }

      // For non-default chains or when DB fails, return user not found
      return NextResponse.json(
        {
          success: true,
          user: {
            walletAddress: userAddress,
            shares: 0,
            valueUSD: 0,
            percentage: 0,
            isMember: false,
            depositCount: 0,
            withdrawalCount: 0,
          },
          pool: null,
          source: 'none',
          warning: 'Pool data unavailable — on-chain and database both unreachable',
        },
        { status: 503 }
      );
    }

    // Sync local storage with on-chain data for a specific user
    if (action === 'sync' && userAddress) {
      const onChainUser = await getOnChainUserPosition(userAddress, chainConfig);
      const onChainPool = await getOnChainPoolData(chainConfig);

      if (!onChainUser || !onChainPool) {
        return NextResponse.json(
          {
            success: false,
            error: 'Failed to fetch on-chain data',
          },
          { status: 500 }
        );
      }

      // Update local storage to match on-chain
      // This is a recovery mechanism - on-chain is always authoritative
      const { saveUserShares, savePoolState, getPoolState, getUserShares } =
        await import('@/lib/storage/community-pool-storage');

      // Sync user position
      let localUser = await getUserShares(userAddress, chainKey);
      if (!localUser && onChainUser.shares > 0) {
        // User exists on-chain but not locally - create record
        localUser = {
          walletAddress: userAddress,
          shares: onChainUser.shares,
          valueUSD: onChainUser.valueUSD,
          percentage: onChainUser.percentage,
          joinedAt: Date.now(),
          updatedAt: Date.now(),
          deposits: [],
          withdrawals: [],
        };
      } else if (localUser) {
        // Sync shares from on-chain (authoritative)
        localUser.shares = onChainUser.shares;
        localUser.valueUSD = onChainUser.valueUSD;
        localUser.percentage = onChainUser.percentage;
        localUser.updatedAt = Date.now();
      }

      if (localUser) {
        await saveUserShares(localUser);
      }

      // Sync pool state
      const localPool = await getPoolState(chainKey);
      localPool.totalShares = onChainPool.totalShares;
      localPool.totalValueUSD = onChainPool.totalValueUSD;
      localPool.sharePrice = onChainPool.sharePrice;
      await savePoolState(localPool, chainKey);

      return NextResponse.json({
        success: true,
        message: 'Synced local storage with on-chain data',
        user: onChainUser,
        pool: onChainPool,
        source: 'onchain',
      });
    }

    // Get transaction history
    if (action === 'history') {
      const limit = Math.min(parseInt(searchParams.get('limit') || '50', 10), 200);
      const history = await getPoolHistory(limit, chainKey);

      return NextResponse.json({
        success: true,
        history,
        count: history.length,
      });
    }

    // Get leaderboard - source varies by chain:
    //   hedera: subgraph adapter (SimpleUsdcVaultV2 has no memberList()
    //           function — getAllOnChainMembers reverts on it)
    //   others: on-chain via getMemberCount() + memberList(i) + members(addr)
    // Display names come from wallet_profiles table (best-effort — no names
    // yet? subgraph addresses stand alone with deterministic identicon).
    if (action === 'leaderboard') {
      const limit = Math.min(parseInt(searchParams.get('limit') || '10', 10), 100);
      const origin = new URL(request.url).origin;

      let leaderboardRaw: Array<{ walletAddress: string; shares: number }> = [];
      let source = 'none';

      if (chainKey === 'hedera') {
        // Adapter serves the ERC-4626-lite vault at share-price = 1, so
        // shares field is already share balance in 6-decimal micros.
        try {
          const gqlRes = await fetch(`${origin}/api/subgraph/hedera`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              query: `{ members(first: ${limit * 3}) { address currentShares totalDeposited } }`,
            }),
            // signal-only server-fetch — no auth header needed
          });
          const gql = (await gqlRes.json()) as {
            data?: { members?: Array<{ address: string; currentShares: string; totalDeposited: string }> };
          };
          const members = (gql.data?.members ?? [])
            .map((m) => ({
              walletAddress: m.address,
              shares: Number(m.currentShares) / 1e6,
            }))
            .filter((m) => m.shares > 0);
          if (members.length > 0) {
            leaderboardRaw = members;
            source = 'hedera-adapter';
          }
        } catch { /* fall through to empty */ }
      } else {
        const onChainMembers = await getAllOnChainMembers(chainConfig);
        if (onChainMembers && onChainMembers.length > 0) {
          leaderboardRaw = onChainMembers.filter((m) => m.shares > 0);
          source = 'onchain';
        }
      }

      if (leaderboardRaw.length === 0) {
        return cachedJsonResponse({ success: true, leaderboard: [], count: 0, source });
      }

      const totalShares = leaderboardRaw.reduce((sum, m) => sum + m.shares, 0);
      const sorted = leaderboardRaw.sort((a, b) => b.shares - a.shares).slice(0, limit);

      // Enrich with display names (best-effort). Table auto-creates on
      // first call; empty result = no names set, avatars still render.
      let profiles: Record<string, { displayName: string | null }> = {};
      try {
        const { getWalletProfiles } = await import('@/lib/db/wallet-profiles');
        profiles = await getWalletProfiles(sorted.map((m) => m.walletAddress));
      } catch { /* no profiles service — that's ok */ }

      const leaderboard = sorted.map((m) => ({
        walletAddress: m.walletAddress,
        shares: m.shares,
        percentage: totalShares > 0 ? (m.shares / totalShares) * 100 : 0,
        displayName: profiles[m.walletAddress.toLowerCase()]?.displayName ?? null,
      }));

      return cachedJsonResponse(
        { success: true, leaderboard, count: leaderboardRaw.length, source },
        60,
      );
    }

    // Get live prices
    if (action === 'prices') {
      const prices = await fetchLivePrices();
      return NextResponse.json({
        success: true,
        prices,
        timestamp: Date.now(),
      });
    }

    // Reset NAV history (admin only - requires cron secret)
    if (action === 'insert-inception') {
      if (!verifyCronSecret(request)) {
        return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
      }

      // Query the actual first deposit from the database
      const { queryOne } = await import('@/lib/db/postgres');
      const firstTx = await queryOne<{ created_at: Date; amount_usd: string; share_price: string }>(
        `SELECT created_at, amount_usd, share_price FROM community_pool_transactions 
         WHERE type = 'DEPOSIT' ORDER BY created_at ASC LIMIT 1`
      );

      let inceptionTimestamp: Date;
      let inceptionSharePrice: number;
      let inceptionNav: number;

      if (firstTx) {
        inceptionTimestamp = new Date(firstTx.created_at);
        inceptionSharePrice = parseFloat(firstTx.share_price) || 1.0;
        inceptionNav = parseFloat(firstTx.amount_usd) || 0;
      } else {
        // No transactions recorded yet — use on-chain contract state
        const onChainData = await getOnChainPoolData(chainConfig);
        if (onChainData && onChainData.totalValueUSD > 0) {
          inceptionTimestamp = new Date();
          inceptionSharePrice = onChainData.sharePrice || 1.0;
          inceptionNav = onChainData.totalValueUSD;
        } else {
          return NextResponse.json(
            {
              success: false,
              error: 'No deposit history found — cannot determine inception',
            },
            { status: 404 }
          );
        }
      }

      const inceptionShares = inceptionNav / inceptionSharePrice;
      const inceptionMembers = 1;

      const inserted = await insertInceptionSnapshot(
        inceptionTimestamp,
        inceptionSharePrice,
        inceptionNav,
        inceptionShares,
        inceptionMembers
      );

      return NextResponse.json({
        success: true,
        inserted,
        message: inserted
          ? 'Inception snapshot added at $' + inceptionSharePrice.toFixed(2) + ' share price'
          : 'Inception snapshot already exists',
        inceptionData: {
          timestamp: inceptionTimestamp.toISOString(),
          sharePrice: inceptionSharePrice,
          nav: inceptionNav,
          shares: inceptionShares,
          source: firstTx ? 'first-transaction' : 'on-chain',
        },
      });
    }

    if (action === 'reset-nav-history') {
      if (!verifyCronSecret(request)) {
        return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
      }

      // Use market-adjusted NAV (virtual holdings × current prices)
      // This ensures reset starts with accurate market values
      const onChainData = await getOnChainPoolData(chainConfig);
      const marketNAV = await calculatePoolNAV(chainConfig.chainKey);

      // Use market-adjusted values but on-chain member count
      const nav = marketNAV.totalValueUSD;
      const sharePrice = marketNAV.sharePrice;
      const totalShares = onChainData?.totalShares || (nav > 0 ? nav / sharePrice : 0);
      const memberCount = onChainData?.totalMembers || 1;

      // Reset with market-adjusted values
      const allocPct: Record<string, number> = {};
      for (const [asset, data] of Object.entries(marketNAV.allocations)) {
        allocPct[asset] = data.percentage;
      }
      const result = await resetNavHistory(nav, sharePrice, totalShares, memberCount, allocPct);

      return NextResponse.json({
        success: true,
        message: 'NAV history reset with market-adjusted values',
        deleted: result.deleted,
        newSnapshot: {
          nav,
          sharePrice,
          totalMembers: memberCount,
        },
      });
    }

    // Default: Get pool summary
    // ALWAYS use on-chain contract data as source of truth
    // On-chain contract has authoritative NAV, share price, and member count
    try {
      const onChainPool = await getOnChainPoolData(chainConfig);

      // Accept ANY valid on-chain response, including an uninitialized
      // pool with totalShares=0 (e.g. Hedera testnet before first deposit).
      // Previously we bailed out when totalShares was zero and fell to the
      // local-DB path which errored for non-cronos chains → "Unable to
      // retrieve pool data" banner. An empty pool is a legitimate state.
      if (onChainPool) {
        // Skip the expensive member-list dedupe when there are no shares.
        const onChainMembers = onChainPool.totalShares > 0
          ? await getAllOnChainMembers(chainConfig)
          : null;
        const uniqueActiveMembers =
          onChainMembers?.filter((m) => m.shares > 0).length ?? onChainPool.totalMembers ?? 0;

        // Check if pool has actual asset holdings or just USDT
        // If all allocations are 0 or assetBalances are 0, pool is holding USDT
        const hasTargetAllocations =
          (onChainPool.allocations.BTC?.percentage || 0) > 0 ||
          (onChainPool.allocations.ETH?.percentage || 0) > 0;

        // Per-chain deposit-token metadata. Hedera pool uses USDC now
        // (SimpleUsdcVault); Sepolia/Cronos are USDT via WDK.
        const depositTokenInfo = getDepositTokenInfo(chainConfig.chainKey, chainConfig.network);
        const depositSymbol = depositTokenInfo.symbol;

        // Determine actual holdings vs target allocations. Uninitialised
        // pools hold their deposit token 1:1 until AI allocation kicks in.
        const actualHoldings = hasTargetAllocations
          ? onChainPool.allocations
          : { [depositSymbol]: { percentage: 100 } };

        // Supported assets deduplicated + include the deposit symbol.
        const supportedAssets = [...new Set([...chainConfig.assets, depositSymbol])];

        // Get deposit-token address for this chain from full config.
        const fullChainConfig = POOL_CHAIN_CONFIGS[chainConfig.chainKey];
        const networkKey = chainConfig.network as 'testnet' | 'mainnet';
        const depositTokenAddress =
          fullChainConfig?.contracts?.[networkKey]?.usdt ||
          fullChainConfig?.contracts?.testnet?.usdt ||
          null;

        return cachedJsonResponse(
          {
            success: true,
            pool: {
              totalValueUSD: onChainPool.totalValueUSD,
              totalShares: onChainPool.totalShares,
              sharePrice: onChainPool.sharePrice,
              memberCount: uniqueActiveMembers,
              allocations: onChainPool.allocations, // Target allocations from contract
              actualHoldings,
              depositAsset: depositSymbol,
              depositTokenAddress,
              lastAIDecision: null,
              performance: { day: null, week: null, month: null },
            },
            supportedAssets,
            timestamp: Date.now(),
            source: 'onchain',
          },
          30
        ); // CDN cache for 30 seconds
      }
    } catch (e) {
      logger.warn('[CommunityPool API] On-chain pool summary failed', { error: e });
    }

    // Final fallback: Local calculated NAV (for when on-chain has no value)
    try {
      const summary = await getPoolSummary(chainConfig.chainKey);

      const depositTokenInfo = getDepositTokenInfo(chainConfig.chainKey, chainConfig.network);
      const fullChainConfig = POOL_CHAIN_CONFIGS[chainConfig.chainKey];
      const networkKey = chainConfig.network as 'testnet' | 'mainnet';
      const depositTokenAddress =
        fullChainConfig?.contracts?.[networkKey]?.usdt ||
        fullChainConfig?.contracts?.testnet?.usdt ||
        null;

      return NextResponse.json({
        success: true,
        pool: {
          ...summary,
          memberCount: summary.totalMembers,
          depositAsset: depositTokenInfo.symbol,
          depositTokenAddress,
        },
        supportedAssets: chainConfig.assets,
        timestamp: Date.now(),
        source: 'calculated',
      });
    } catch (e) {
      logger.error('[CommunityPool API] All pool summary fallbacks failed');
      return NextResponse.json(
        {
          success: false,
          error: 'Unable to retrieve pool data',
        },
        { status: 500 }
      );
    }
  } catch (error: unknown) {
    return safeErrorResponse(error, 'community-pool GET');
  }
}

/**
 * POST - Deposit or withdraw
 * SECURITY: deposit/withdraw require wallet auth to verify the caller owns the wallet.
 * Admin actions (sync-from-chain, delete-user) require CRON_SECRET.
 */
export async function POST(request: NextRequest) {
  // Rate limit mutations
  const limited = mutationLimiter.check(request);
  if (limited) return limited;

  const searchParams = request.nextUrl.searchParams;
  const action = searchParams.get('action');

  // Multi-chain support: parse chain and network params
  const chainParam = searchParams.get('chain');
  const networkParam = searchParams.get('network');
  const chainConfig = getChainConfig(chainParam, networkParam);

  // SUI chain requires different handling (not EVM-compatible)
  if (chainConfig.chainKey === 'sui') {
    return NextResponse.json(
      {
        success: false,
        error: 'SUI chain requires the SUI-specific API endpoint',
        hint: 'Use /api/sui/community-pool for SUI chain operations',
      },
      { status: 400 }
    );
  }

  // Paper is a virtual pool — not backed by an on-chain contract. Its
  // data lives in cron_state and is served by /api/paper-trader/status.
  if (chainConfig.chainKey === 'paper') {
    return NextResponse.json(
      {
        success: false,
        error: 'Paper pool has no on-chain contract',
        hint: 'Use /api/paper-trader/status for paper pool data',
      },
      { status: 400 }
    );
  }

  try {
    const body = await request.json();
    const { walletAddress, amount, shares, txHash } = body;

    // Admin actions like sync-from-chain and delete-user don't require walletAddress upfront
    const adminActions = ['sync-from-chain', 'delete-user'];
    if (!walletAddress && !adminActions.includes(action || '')) {
      return NextResponse.json(
        { success: false, error: 'walletAddress required' },
        { status: 400 }
      );
    }

    // SECURITY: For deposit/withdraw, verify the caller owns the wallet.
    // Accepts either wallet signature OR verified on-chain txHash.
    const userActions = ['deposit', 'withdraw'];
    if (userActions.includes(action || '')) {
      const authResult = await requireAuth(request, body);
      if (authResult instanceof NextResponse) return authResult;

      // If wallet auth was used, verify the authenticated wallet matches the request
      if (
        authResult.method === 'wallet' &&
        authResult.identity?.toLowerCase() !== walletAddress?.toLowerCase()
      ) {
        return NextResponse.json(
          { success: false, error: 'Wallet address does not match authenticated wallet' },
          { status: 403 }
        );
      }
    }

    const ctx: HandlerContext = {
      request,
      chainConfig,
      walletAddress,
      amount,
      shares,
      txHash,
    };

    switch (action) {
      case 'deposit':
        return await handleDeposit(ctx);
      case 'withdraw':
        return await handleWithdraw(ctx);
      case 'sync-from-chain':
        return await handleSyncFromChain(ctx);
      case 'delete-user':
        return await handleDeleteUser(ctx);
      case 'full-reset':
        return await handleFullReset(ctx);
      default:
        return NextResponse.json(
          { success: false, error: 'Invalid action. Use: deposit, withdraw, sync-from-chain, delete-user, full-reset' },
          { status: 400 },
        );
    }
  } catch (error: unknown) {
    return safeErrorResponse(error, 'community-pool POST');
  }
}
