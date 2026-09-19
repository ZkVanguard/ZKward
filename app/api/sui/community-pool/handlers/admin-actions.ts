/**
 * Admin POST-action handlers for the sui/community-pool route.
 * All 5 actions require QStash signature or CRON_SECRET auth.
 *
 * Extracted from route.ts on 2026-08-10 to keep the dispatcher thin.
 */
import { NextResponse } from 'next/server';
import { verifyCronRequest } from '@/lib/qstash';
import { getSuiUsdcPoolService } from '@/lib/services/sui/SuiCommunityPoolService';
import { getBluefinAggregatorService, type PoolAsset } from '@/lib/services/sui/BluefinAggregatorService';
import type { ActionCtx } from './types';

export async function handleCollectFees(ctx: ActionCtx): Promise<NextResponse> {
  const { request, network } = ctx;
  const authResult = await verifyCronRequest(request, 'SUI collect-fees');
  if (authResult !== true) {
    return NextResponse.json({ success: false, error: 'Unauthorized — admin operation requires authentication' }, { status: 401 });
  }

  const service = getSuiUsdcPoolService(network);
  await service.getPoolStats();

  const treasuryInfo = await service.getTreasuryInfo();
  if (treasuryInfo.totalPendingFees <= 0) {
    return NextResponse.json({ success: false, error: 'No pending fees to collect' }, { status: 400 });
  }

  const params = service.buildCollectFeesParams();
  return NextResponse.json({
    success: true,
    data: {
      ...params,
      pendingFees: treasuryInfo.totalPendingFees,
      treasuryAddress: treasuryInfo.treasuryAddress,
      msafeConfigured: treasuryInfo.msafeConfigured,
    },
    chain: 'sui',
    network,
  });
}

export async function handleSetTreasury(ctx: ActionCtx): Promise<NextResponse> {
  const { request, network, body } = ctx;
  const authResult = await verifyCronRequest(request, 'SUI set-treasury');
  if (authResult !== true) {
    return NextResponse.json({ success: false, error: 'Unauthorized — admin operation requires authentication' }, { status: 401 });
  }

  const newTreasury = body.newTreasury as string | undefined;
  if (!newTreasury || !/^0x[a-fA-F0-9]{64}$/.test(newTreasury)) {
    return NextResponse.json({ success: false, error: 'Valid SUI address required (0x + 64 hex chars)' }, { status: 400 });
  }

  const service = getSuiUsdcPoolService(network);
  await service.getPoolStats();

  const params = service.buildSetTreasuryParams(newTreasury);
  return NextResponse.json({ success: true, data: params, chain: 'sui', network });
}

/**
 * admin-recover: sell all non-USDC admin assets and return USDC to pool
 * via a micro-hedge open/close cycle. CRON_SECRET-gated.
 */
export async function handleAdminRecover(ctx: ActionCtx): Promise<NextResponse> {
  const { request, network } = ctx;
  const authResult = await verifyCronRequest(request, 'SUI admin-recover');
  if (authResult !== true) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const startTime = Date.now();
  const adminKey = (process.env.SUI_POOL_ADMIN_KEY || process.env.BLUEFIN_PRIVATE_KEY || '').trim();
  const agentCapId = (process.env.SUI_AGENT_CAP_ID || process.env.SUI_ADMIN_CAP_ID || '').trim();
  if (!adminKey || !agentCapId) {
    return NextResponse.json({ success: false, error: 'SUI_POOL_ADMIN_KEY / SUI_AGENT_CAP_ID not configured' }, { status: 503 });
  }

  const { Ed25519Keypair } = await import('@mysten/sui/keypairs/ed25519');
  const { createFailoverSuiClient } = await import('@/lib/services/sui/sui-failover-transport');
  const { SUI_USDC_POOL_CONFIG } = await import('@/lib/types/sui-pool-types');
  const { getMarketDataService } = await import('@/lib/services/market-data/RealMarketDataService');

  const keypair = adminKey.startsWith('suiprivkey')
    ? Ed25519Keypair.fromSecretKey(adminKey)
    : Ed25519Keypair.fromSecretKey(Buffer.from(adminKey.replace(/^0x/, ''), 'hex'));
  const address = keypair.getPublicKey().toSuiAddress();

  const suiClient = createFailoverSuiClient(network);

  const mds = getMarketDataService();
  const [btcPrice, ethPrice, suiPrice] = await Promise.all([
    mds.getTokenPrice('BTC').then(p => p.price).catch(() => 0),
    mds.getTokenPrice('ETH').then(p => p.price).catch(() => 0),
    mds.getTokenPrice('SUI').then(p => p.price).catch(() => 0),
  ]);
  const _pricesUSD: Record<string, number> = { BTC: btcPrice, ETH: ethPrice, SUI: suiPrice };

  const aggregator = getBluefinAggregatorService(network);
  const allBalances = await suiClient.getAllBalances({ owner: address });
  const { MAINNET_COIN_TYPES, ASSET_TO_COIN_KEY, ASSET_DECIMALS } = await import('@/lib/types/bluefin-types');
  const usdcType = MAINNET_COIN_TYPES.USDC;

  const swapResults: Array<{ asset: string; sold: number; usdcReceived: number; txDigest?: string; error?: string }> = [];
  for (const bal of allBalances) {
    if (bal.coinType === usdcType || bal.coinType === '0x2::sui::SUI') continue;
    const raw = Number(bal.totalBalance);
    if (raw <= 0) continue;

    const assetEntry = Object.entries(ASSET_TO_COIN_KEY).find(([, key]) => MAINNET_COIN_TYPES[key] === bal.coinType);
    if (!assetEntry) continue;
    const asset = assetEntry[0] as PoolAsset;
    const decimals = ASSET_DECIMALS[ASSET_TO_COIN_KEY[asset]] || 8;
    const amount = raw / Math.pow(10, decimals);
    if (amount < 1e-8) continue;

    try {
      const reverseQuote = await aggregator.getReverseSwapQuote(asset, amount);
      if (!reverseQuote.canSwapOnChain) {
        swapResults.push({ asset, sold: amount, usdcReceived: 0, error: 'No on-chain route' });
        continue;
      }
      const swapResult = await aggregator.executeSwap(reverseQuote, 0.025);
      const usdcReceived = Number(swapResult.amountOut || '0') / 1e6;
      swapResults.push({ asset, sold: amount, usdcReceived, txDigest: swapResult.txDigest, error: swapResult.error });
      if (swapResult.success) await new Promise(r => setTimeout(r, 2500));
    } catch (e) {
      swapResults.push({ asset, sold: amount, usdcReceived: 0, error: String(e) });
    }
  }

  const totalReplenished = swapResults.reduce((s, r) => s + r.usdcReceived, 0);

  let poolReturn: { success: boolean; returned?: number; txDigest?: string; error?: string } = { success: false };
  if (totalReplenished > 1.0) {
    const usdcCoins = await suiClient.getCoins({ owner: address, coinType: usdcType });
    const adminUsdc = usdcCoins.data.reduce((s, c) => s + Number(c.balance), 0) / 1e6;

    if (adminUsdc > 1.0) {
      const poolConfig = SUI_USDC_POOL_CONFIG[network];
      if (poolConfig.poolStateId && poolConfig.packageId) {
        const hedgesObj = await suiClient.getObject({ id: poolConfig.poolStateId, options: { showContent: true } });
        const fields = (hedgesObj.data?.content as any)?.fields;
        const activeHedgesList: any[] = fields?.hedge_state?.fields?.active_hedges || [];

        let hedgeId: number[] | null = null;
        let microHedgeUsdc = 0;

        if (activeHedgesList.length === 0) {
          const { Transaction } = await import('@mysten/sui/transactions');
          const MICRO = 10_000;
          const poolCoins = await suiClient.getCoins({ owner: address, coinType: usdcType });
          if (poolCoins.data.length === 0) {
            poolReturn = { success: false, error: 'Admin has no USDC coins to create micro-hedge' };
          } else {
            try {
              const tx = new Transaction();
              const primary = tx.object(poolCoins.data[0].coinObjectId);
              if (poolCoins.data.length > 1) tx.mergeCoins(primary, poolCoins.data.slice(1).map(c => tx.object(c.coinObjectId)));
              tx.moveCall({
                target: `${poolConfig.packageId}::${poolConfig.moduleName}::open_hedge`,
                typeArguments: [usdcType],
                arguments: [
                  tx.object(agentCapId),
                  tx.object(poolConfig.poolStateId!),
                  tx.pure.u64(MICRO),
                  tx.object('0x6'),
                ],
              });
              tx.setGasBudget(30_000_000);
              const openTx = await suiClient.signAndExecuteTransaction({ transaction: tx, signer: keypair, options: { showEffects: true } });
              if (openTx.effects?.status?.status === 'success') {
                await new Promise(r => setTimeout(r, 3000));
                const freshObj = await suiClient.getObject({ id: poolConfig.poolStateId!, options: { showContent: true } });
                const freshFields = (freshObj.data?.content as any)?.fields;
                const freshHedges: any[] = freshFields?.hedge_state?.fields?.active_hedges || [];
                if (freshHedges.length > 0) {
                  const h = freshHedges[freshHedges.length - 1];
                  hedgeId = Array.from(Buffer.from((h.fields || h).id || '', 'hex'));
                  microHedgeUsdc = MICRO / 1e6;
                }
              }
            } catch (openErr) {
              poolReturn = { success: false, error: `Micro-hedge open failed: ${openErr}` };
            }
          }
        } else {
          const h = activeHedgesList[0];
          hedgeId = Array.from(Buffer.from((h.fields || h).id || '', 'hex'));
          microHedgeUsdc = Number((h.fields || h).collateral_usdc || 0) / 1e6;
        }

        if (hedgeId && !poolReturn.error) {
          const freshCoins = await suiClient.getCoins({ owner: address, coinType: usdcType });
          const totalAdminUsdc = freshCoins.data.reduce((s, c) => s + Number(c.balance), 0) / 1e6;
          const pnl = Math.max(0, totalAdminUsdc - microHedgeUsdc);
          const { Transaction } = await import('@mysten/sui/transactions');
          const tx2 = new Transaction();
          const primary2 = tx2.object(freshCoins.data[0].coinObjectId);
          if (freshCoins.data.length > 1) tx2.mergeCoins(primary2, freshCoins.data.slice(1).map(c => tx2.object(c.coinObjectId)));
          const [returnCoin] = tx2.splitCoins(primary2, [Math.floor(totalAdminUsdc * 1e6)]);
          tx2.moveCall({
            target: `${poolConfig.packageId}::${poolConfig.moduleName}::close_hedge`,
            typeArguments: [usdcType],
            arguments: [
              tx2.object(agentCapId),
              tx2.object(poolConfig.poolStateId!),
              tx2.pure.vector('u8', hedgeId),
              tx2.pure.u64(Math.floor(pnl * 1e6)),
              tx2.pure.bool(pnl > 0),
              returnCoin,
              tx2.object('0x6'),
            ],
          });
          tx2.setGasBudget(50_000_000);
          const closeTx = await suiClient.signAndExecuteTransaction({ transaction: tx2, signer: keypair, options: { showEffects: true } });
          if (closeTx.effects?.status?.status === 'success') {
            poolReturn = { success: true, returned: totalAdminUsdc, txDigest: closeTx.digest };
          } else {
            poolReturn = { success: false, error: closeTx.effects?.status?.error };
          }
        }
      }
    }
  }

  return NextResponse.json({
    success: true,
    action: 'admin-recover',
    swapResults,
    totalReplenished: totalReplenished.toFixed(6),
    poolReturn,
    duration: Date.now() - startTime,
    chain: 'sui',
    network,
  });
}

export async function handleTriggerCron(ctx: ActionCtx): Promise<NextResponse> {
  const { request } = ctx;
  const authResult = await verifyCronRequest(request, 'SUI trigger-cron');
  if (authResult !== true) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const jobsToken = process.env.JOBS_PUBLISH_TOKEN;
  if (!jobsToken) {
    return NextResponse.json({ success: false, error: 'JOBS_PUBLISH_TOKEN not configured' }, { status: 503 });
  }

  const cronUrl = `${process.env.NEXT_PUBLIC_APP_URL || 'https://www.zkward.com'}/api/cron/sui-community-pool`;
  const jobsBase = (process.env.JOBS_URL || 'https://jobs.zkward.com').replace(/\/$/, '');
  const res = await fetch(`${jobsBase}/v1/publish`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jobsToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      destination: cronUrl,
      payload: { kind: 'sui-community-pool-adhoc' },
      idempotencyKey: `sui-community-pool-adhoc-${Date.now()}`,
    }),
  });

  const result = await res.json().catch(() => ({}));
  return NextResponse.json({
    success: res.ok,
    queued: res.ok,
    jobId: (result as any)?.id,
    cronUrl,
    status: res.status,
    chain: 'sui',
  });
}

export async function handleReconcile(ctx: ActionCtx): Promise<NextResponse> {
  const { request } = ctx;
  const authResult = await verifyCronRequest(request, 'SUI reconcile');
  if (authResult !== true) {
    return NextResponse.json({ success: false, error: 'Unauthorized — admin operation requires authentication' }, { status: 401 });
  }

  const { reconcileSuiHedges } = await import('@/lib/services/sui/SuiHedgeReconciler');
  const result = await reconcileSuiHedges();

  return NextResponse.json({
    success: true,
    onChain: result.onChainCount,
    db: result.dbCount,
    inserted: result.inserted,
    closed: result.closed,
    unchanged: result.unchanged,
    errors: result.errors,
  });
}
