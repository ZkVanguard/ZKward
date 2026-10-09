/**
 * Public status for the Solana token pool — the dashboard's data source and
 * the "is it real" URL anyone can curl. Read-only, no auth (exposes nothing
 * that isn't on-chain or derived).
 */

import { NextResponse } from 'next/server';
import { errMsg } from '@/lib/utils/error-handler';
import { logger } from '@/lib/utils/logger';
import { envFlag } from '@/lib/utils/env-flag';
import { withOriginCache } from '@/lib/utils/origin-cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handleGet(): Promise<NextResponse> {
  if (!envFlag('SOLANA_POOL_ENABLED')) {
    return NextResponse.json({ enabled: false });
  }
  try {
    const [svc, rpc, poolState, db, price] = await Promise.all([
      import('@/lib/services/solana/SolanaPoolService'),
      import('@/lib/services/solana/rpc'),
      import('@/lib/services/solana/pool-state'),
      import('@/lib/db/solana-pool'),
      import('@/lib/services/solana/price'),
    ]);

    const { getSleeveStatus } = await import('@/lib/services/solana/SolanaSleeveTrader');
    const ata = svc.vaultAta();
    const cluster = svc.solanaCluster();
    const capRaw = svc.depositCapRaw();
    const [balance, totalSharesRaw, accountedRaw, recent, tokenPrice, sleeve, members] = await Promise.all([
      ata ? rpc.getTokenAccountBalance(ata).catch(() => null) : Promise.resolve(null),
      db.getTotalSharesRaw(),
      db.getAccountedTokensRaw(),
      db.getRecentDeposits(10),
      price.getPoolTokenUsdPrice(),
      getSleeveStatus().catch(() => null),
      db.getMembers(),
    ]);

    const vaultRaw = balance ? BigInt(balance.amount) : null;
    // Share price + NAV from the ledger; chain balance above it is deposits
    // still being indexed (they belong to their depositors, not holders).
    const valuation = poolState.ledgerValuation(accountedRaw, totalSharesRaw, tokenPrice?.usd ?? null);
    const vaultUi = vaultRaw !== null ? poolState.toUi(vaultRaw) : null;
    const accountedUi = poolState.toUi(accountedRaw);
    const pendingUi =
      vaultRaw !== null && vaultRaw > accountedRaw ? poolState.toUi(vaultRaw - accountedRaw) : 0;

    return NextResponse.json({
      enabled: true,
      testnet: cluster !== 'mainnet-beta',
      cluster,
      vaultAta: ata || null,
      tokenMint: (process.env.SOLANA_POOL_TOKEN_MINT || '').trim() || null,
      // The browser's endpoint. The server's own URL carries a provider key on mainnet.
      rpcUrl: rpc.solanaPublicRpcUrl(),
      withdrawalsPaused: svc.withdrawalsPaused(),
      depositCapTokens: capRaw === null ? null : poolState.toUi(capRaw),
      depositsOpen: capRaw === null || accountedRaw < capRaw,
      vaultTokens: vaultUi,
      accountedTokens: accountedUi,
      pendingTokens: pendingUi,
      solvent: vaultRaw === null ? null : vaultRaw >= accountedRaw,
      totalShares: poolState.toUi(totalSharesRaw),
      // Count and list come from the same ledger rows, so they always agree.
      memberCount: members.length,
      members: members.slice(0, 25).map((m) => ({
        wallet: m.wallet,
        shares: poolState.toUi(m.sharesRaw),
        percentage: totalSharesRaw > 0n ? Number((m.sharesRaw * 10_000n) / totalSharesRaw) / 100 : 0,
      })),
      sharePrice: valuation.sharePrice,
      tokenUsd: tokenPrice?.usd ?? null,
      navUsd: valuation.navUsd,
      priceNote: cluster === 'mainnet-beta'
        ? 'priced at the token’s mainnet Jupiter quote'
        : 'devnet mirror priced at the real token’s mainnet Jupiter quote',
      sleeve: sleeve
        ? {
            // Per coin: the sleeve opens only where this says "proven".
            evidence: sleeve.evidence,
            trades: sleeve.stats.trades,
            wins: sleeve.stats.wins,
            winRatePct:
              sleeve.stats.trades > 0
                ? Math.round((sleeve.stats.wins / sleeve.stats.trades) * 1000) / 10
                : null,
            // Realized sleeve PnL = the plan's "pending buyback" line: it
            // becomes vault tokens only via real mainnet buybacks, so share
            // price stays chain-truth on testnet.
            pendingBuybackUsd: Math.round(sleeve.stats.cumRealizedUsd * 100) / 100,
            position: sleeve.position
              ? {
                  orderId: sleeve.position.orderId,
                  asset: sleeve.position.position.asset,
                  side: sleeve.position.position.side,
                  entryPrice: sleeve.position.position.entryPrice,
                  notionalUsd: sleeve.position.position.notionalUsd,
                  markPrice: sleeve.position.markPrice,
                  unrealizedPnlUsd: sleeve.position.unrealizedPnlUsd,
                  openedAt: sleeve.position.position.openedAt,
                }
              : null,
          }
        : null,
      recentDeposits: recent.map((r) => ({
        signature: r.signature,
        sender: r.sender,
        amount: Number(r.amount_raw) / 1e6,
        shares: Number(r.shares_minted_raw) / 1e6,
        slot: Number(r.slot),
        blockTime: r.block_time,
      })),
    }, {
      // Pool-wide (a wallet's balance has its own uncached route). Without a
      // header every visit paid ~3 s of chain and database reads.
      headers: { 'Cache-Control': 'public, s-maxage=15, stale-while-revalidate=86400' },
    });
  } catch (e) {
    // The detail stays in the log: an RPC error can carry the endpoint's URL.
    logger.warn('[SolanaPool] status failed', { error: errMsg(e) });
    return NextResponse.json({ enabled: true, error: 'pool status is unavailable right now' }, { status: 500 });
  }
}

export const GET = withOriginCache({ name: 'solana-status', freshSec: 15 }, handleGet);
