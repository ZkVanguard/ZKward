/**
 * Debug: SUI Pool Status & Last Cron Run
 *
 * Returns detailed info about the SUI pool state and last cron execution.
 * Protected by DEBUG_SECRET env var.
 */

import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db/postgres';
import {
  getSuiUsdcPoolService,
  SUI_USDC_POOL_CONFIG,
} from '@/lib/services/sui/SuiCommunityPoolService';
import { BluefinService } from '@/lib/services/sui/BluefinService';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const BUILD_TIMESTAMP = new Date().toISOString();

export async function GET(_request: NextRequest): Promise<NextResponse> {
  // Allow unauthenticated access - this endpoint only shows status, no secrets
  const network = (process.env.SUI_NETWORK || 'testnet').trim() as 'mainnet' | 'testnet';

  const result: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    buildTimestamp: BUILD_TIMESTAMP,
    network,
    envVars: {
      SUI_NETWORK: process.env.SUI_NETWORK
        ? `${network} (raw: ${process.env.SUI_NETWORK.length} chars)`
        : 'NOT SET',
      SUI_POOL_ADMIN_KEY: process.env.SUI_POOL_ADMIN_KEY ? '✅ SET' : '❌ NOT SET',
      SUI_AGENT_CAP_ID: process.env.SUI_AGENT_CAP_ID ? '✅ SET' : '❌ NOT SET',
      SUI_ADMIN_CAP_ID: process.env.SUI_ADMIN_CAP_ID ? '✅ SET' : '❌ NOT SET',
      BLUEFIN_PRIVATE_KEY: process.env.BLUEFIN_PRIVATE_KEY ? '✅ SET' : '❌ NOT SET',
      JOBS_SIGNING_SECRET: process.env.JOBS_SIGNING_SECRET ? '✅ SET' : '❌ NOT SET',
    },
    poolConfig: SUI_USDC_POOL_CONFIG[network],
  };

  // Fetch on-chain pool stats
  try {
    const suiService = getSuiUsdcPoolService(network);
    const poolStats = await suiService.getPoolStats();
    result.onChainPoolStats = poolStats;
  } catch (err) {
    result.onChainPoolStats = { error: err instanceof Error ? err.message : String(err) };
  }

  // Fetch last AI decision from DB
  try {
    const lastDecisions = (await query(
      `SELECT created_at, details FROM community_pool_transactions 
       WHERE type = 'AI_DECISION' AND details->>'chain' = 'sui'
       ORDER BY created_at DESC LIMIT 3`
    )) as Array<{ created_at: Date; details: Record<string, unknown> }>;
    result.lastAIDecisions = lastDecisions.map((d) => {
      const det = d.details as Record<string, unknown>;
      return {
        timestamp: d.created_at,
        allocations: det?.allocations,
        confidence: det?.confidence,
        action: det?.action,
        marketSentiment: det?.marketSentiment,
        urgency: det?.urgency,
        recommendations: det?.recommendations,
        riskAlerts: det?.riskAlerts,
        // Truncate reasoning to keep payload bounded
        reasoning:
          typeof det?.reasoning === 'string' ? (det.reasoning as string).slice(0, 500) : undefined,
      };
    });
  } catch (err) {
    result.lastAIDecisions = { error: err instanceof Error ? err.message : String(err) };
  }

  // Fetch recent NAV snapshots
  try {
    const navSnapshots = (await query(
      `SELECT timestamp, share_price, total_nav, member_count, allocations 
       FROM community_pool_nav 
       WHERE chain = 'sui'
       ORDER BY timestamp DESC LIMIT 5`
    )) as Array<{
      timestamp: Date;
      share_price: number;
      total_nav: number;
      member_count: number;
      allocations: Record<string, number>;
    }>;
    result.recentNavSnapshots = navSnapshots;
  } catch (err) {
    result.recentNavSnapshots = { error: err instanceof Error ? err.message : String(err) };
  }

  // Fetch recent pool transactions (swaps, hedges, etc.)
  try {
    const txns = (await query(
      `SELECT created_at, type, details FROM community_pool_transactions 
       WHERE details->>'chain' = 'sui'
       ORDER BY created_at DESC LIMIT 10`
    )) as Array<{ created_at: Date; type: string; details: Record<string, unknown> }>;
    result.recentTransactions = txns;
  } catch (err) {
    result.recentTransactions = { error: err instanceof Error ? err.message : String(err) };
  }

  // Check admin wallet USDC balance
  try {
    const { createFailoverSuiClient } = await import('@/lib/services/sui/sui-failover-transport');
    const { Ed25519Keypair } = await import('@mysten/sui/keypairs/ed25519');

    const adminKey = (
      process.env.SUI_POOL_ADMIN_KEY ||
      process.env.BLUEFIN_PRIVATE_KEY ||
      ''
    ).trim();
    if (adminKey) {
      let keypair: InstanceType<typeof Ed25519Keypair>;
      if (adminKey.startsWith('suiprivkey')) {
        keypair = Ed25519Keypair.fromSecretKey(adminKey);
      } else {
        keypair = Ed25519Keypair.fromSecretKey(Buffer.from(adminKey.replace('0x', ''), 'hex'));
      }
      const adminAddress = keypair.getPublicKey().toSuiAddress();

      const client = createFailoverSuiClient(network);

      // Get USDC balance
      const usdcType = SUI_USDC_POOL_CONFIG[network].usdcCoinType;
      const coins = await client.getCoins({ owner: adminAddress, coinType: usdcType });
      const usdcBalance = coins.data.reduce((sum, c) => sum + BigInt(c.balance), 0n);

      // Get SUI balance for gas
      const suiBalance = await client.getBalance({ owner: adminAddress });

      result.adminWallet = {
        address: adminAddress,
        usdcBalance: (Number(usdcBalance) / 1e6).toFixed(2),
        suiBalance: (Number(suiBalance.totalBalance) / 1e9).toFixed(4),
      };

      // Get on-chain pool hedge state
      const poolConfig = SUI_USDC_POOL_CONFIG[network];
      if (poolConfig.poolStateId) {
        const obj = await client.getObject({
          id: poolConfig.poolStateId,
          options: { showContent: true },
        });
        const fields = (obj.data?.content as any)?.fields;
        if (fields) {
          const rawBal =
            typeof fields.balance === 'string'
              ? fields.balance
              : fields.balance?.fields?.value || '0';
          const contractBalance = Number(rawBal) / 1e6;

          const hedgeState = fields.hedge_state?.fields || {};
          const totalHedgedValue = Number(hedgeState.total_hedged_value || '0') / 1e6;
          const hedgedToday = Number(hedgeState.hedged_today || '0') / 1e6;
          const autoHedgeConfig = hedgeState.auto_hedge_config?.fields || {};

          // Calculate limits
          const maxHedgeRatioBps = Number(autoHedgeConfig.max_hedge_ratio_bps || 5000);
          const maxHedgeTotal = contractBalance * (maxHedgeRatioBps / 10000);
          const maxByHedgeRatio = Math.max(0, maxHedgeTotal - totalHedgedValue);
          const maxByReserve = contractBalance * 0.8;
          const dailyCapBps = Number(autoHedgeConfig.daily_hedge_cap_bps || 1500);
          const maxByDailyCap = contractBalance * (dailyCapBps / 10000) - hedgedToday;

          result.onChainHedgeState = {
            contractBalance: contractBalance.toFixed(2),
            totalHedgedValue: totalHedgedValue.toFixed(2),
            hedgedToday: hedgedToday.toFixed(2),
            maxHedgeRatioBps,
            dailyCapBps,
            calculatedLimits: {
              maxHedgeTotal: maxHedgeTotal.toFixed(2),
              maxByHedgeRatio: maxByHedgeRatio.toFixed(2),
              maxByReserve: maxByReserve.toFixed(2),
              maxByDailyCap: maxByDailyCap.toFixed(2),
              finalMaxTransferable: Math.min(maxByHedgeRatio, maxByReserve, maxByDailyCap).toFixed(
                2
              ),
            },
          };

          // Read active hedges from on-chain
          const activeHedges = hedgeState.active_hedges || [];
          result.activeHedges = activeHedges.map((h: any) => ({
            hedgeId: Buffer.from(h.fields?.hedge_id || h.hedge_id || [], 'base64').toString('hex'),
            pairIndex: h.fields?.pair_index ?? h.pair_index,
            collateralUsdc: (
              Number(h.fields?.collateral_usdc || h.collateral_usdc || 0) / 1e6
            ).toFixed(2),
            leverage: h.fields?.leverage ?? h.leverage,
            isLong: h.fields?.is_long ?? h.is_long,
            openedAt: h.fields?.opened_at ?? h.opened_at,
          }));
        }
      }
    }
  } catch (err) {
    result.adminWallet = { error: err instanceof Error ? err.message : String(err) };
  }

  // Check BlueFin positions
  try {
    const bluefin = BluefinService.getInstance();
    const adminKey = (
      process.env.SUI_POOL_ADMIN_KEY ||
      process.env.BLUEFIN_PRIVATE_KEY ||
      ''
    ).trim();
    if (adminKey) {
      await bluefin.initialize(adminKey, network);
      const positions = await bluefin.getPositions();
      result.bluefinPositions = positions.map((p) => ({
        symbol: p.symbol,
        side: p.side,
        size: p.size,
        entryPrice: p.entryPrice,
        unrealizedPnl: p.unrealizedPnl,
        margin: p.margin,
      }));
    } else {
      result.bluefinPositions = { error: 'No admin key configured' };
    }
  } catch (err) {
    result.bluefinPositions = { error: err instanceof Error ? err.message : String(err) };
  }

  return NextResponse.json(result, {
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
      Pragma: 'no-cache',
      Expires: '0',
    },
  });
}
