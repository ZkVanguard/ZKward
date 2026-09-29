/**
 * Public status for the Solana token pool — the dashboard's data source and
 * the "is it real" URL anyone can curl. Read-only, no auth (exposes nothing
 * that isn't on-chain or derived).
 */

import { NextResponse } from 'next/server';
import { errMsg } from '@/lib/utils/error-handler';
import { envFlag } from '@/lib/utils/env-flag';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  if (!envFlag('SOLANA_POOL_ENABLED')) {
    return NextResponse.json({ enabled: false });
  }
  try {
    const [{ vaultAta, solanaCluster }, rpc, poolState, db, price] = await Promise.all([
      import('@/lib/services/solana/SolanaPoolService'),
      import('@/lib/services/solana/rpc'),
      import('@/lib/services/solana/pool-state'),
      import('@/lib/db/solana-pool'),
      import('@/lib/services/solana/price'),
    ]);

    const ata = vaultAta();
    const [balance, totalSharesRaw, recent, tokenPrice] = await Promise.all([
      ata ? rpc.getTokenAccountBalance(ata).catch(() => null) : Promise.resolve(null),
      db.getTotalSharesRaw(),
      db.getRecentDeposits(10),
      price.getPoolTokenUsdPrice(),
    ]);

    const vaultRaw = balance ? BigInt(balance.amount) : null;
    const p = poolState.sharePrice(vaultRaw ?? 0n, totalSharesRaw);
    const sharePriceUi =
      totalSharesRaw > 0n && vaultRaw !== null ? Number(p.num) / Number(p.den) : 1.0;
    const vaultUi = vaultRaw !== null ? poolState.toUi(vaultRaw) : null;

    return NextResponse.json({
      enabled: true,
      testnet: (process.env.SOLANA_CLUSTER || 'devnet').trim() !== 'mainnet-beta',
      cluster: (process.env.SOLANA_CLUSTER || 'devnet').trim(),
      vaultAta: ata || null,
      vaultTokens: vaultUi,
      totalShares: poolState.toUi(totalSharesRaw),
      sharePrice: sharePriceUi,
      tokenUsd: tokenPrice?.usd ?? null,
      navUsd: vaultUi !== null && tokenPrice ? vaultUi * tokenPrice.usd : null,
      priceNote: 'devnet mirror priced at the real token’s mainnet Jupiter quote',
      recentDeposits: recent.map((r) => ({
        signature: r.signature,
        sender: r.sender,
        amount: Number(r.amount_raw) / 1e6,
        shares: Number(r.shares_minted_raw) / 1e6,
        slot: Number(r.slot),
        blockTime: r.block_time,
      })),
    });
  } catch (e) {
    return NextResponse.json({ enabled: true, error: errMsg(e) }, { status: 500 });
  }
}
