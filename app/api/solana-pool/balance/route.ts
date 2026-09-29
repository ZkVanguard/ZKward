/** Per-wallet pool position: net shares + current token value. Public read. */
import { NextRequest, NextResponse } from 'next/server';
import { errMsg } from '@/lib/utils/error-handler';
import { envFlag } from '@/lib/utils/env-flag';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!envFlag('SOLANA_POOL_ENABLED')) return NextResponse.json({ enabled: false });
  const wallet = (request.nextUrl.searchParams.get('wallet') || '').trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) {
    return NextResponse.json({ error: 'invalid wallet' }, { status: 400 });
  }
  try {
    const { getWalletSharesRaw, getTotalSharesRaw } = await import('@/lib/db/solana-pool');
    const { toUi, sharePrice } = await import('@/lib/services/solana/pool-state');
    const { getTokenAccountBalance } = await import('@/lib/services/solana/rpc');
    const { vaultAta } = await import('@/lib/services/solana/SolanaPoolService');

    const [owned, total, balance] = await Promise.all([
      getWalletSharesRaw(wallet),
      getTotalSharesRaw(),
      getTokenAccountBalance(vaultAta()).catch(() => null),
    ]);
    const p = balance ? sharePrice(BigInt(balance.amount), total) : { num: 1n, den: 1n };
    const valueRaw = (owned * p.num) / p.den;
    return NextResponse.json({
      wallet,
      sharesUi: toUi(owned),
      tokenValueUi: toUi(valueRaw),
      poolSharePct: total > 0n ? Number((owned * 10_000n) / total) / 100 : 0,
    });
  } catch (e) {
    return NextResponse.json({ error: errMsg(e) }, { status: 500 });
  }
}
