/** Per-wallet pool position: net shares + current token value + JIMP still in the wallet. Public read. */
import { NextRequest, NextResponse } from 'next/server';
import { errMsg } from '@/lib/utils/error-handler';
import { envFlag } from '@/lib/utils/env-flag';
import { logger } from '@/lib/utils/logger';
import { readLimiter } from '@/lib/security/rate-limiter';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * JIMP sitting in the wallet (not deposited). The faucet and a withdrawal
 * land here, so without it the card shows no change after either. null when
 * the chain read failed; 0 only when the wallet simply has no token account.
 */
async function walletTokenBalanceUi(wallet: string): Promise<number | null> {
  const mint = (process.env.SOLANA_POOL_TOKEN_MINT || '').trim();
  if (!mint) return null;
  try {
    const { PublicKey } = await import('@solana/web3.js');
    const { getAssociatedTokenAddressSync } = await import('@/lib/services/solana/spl');
    const { getTokenAccountBalance } = await import('@/lib/services/solana/rpc');
    const ata = getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(wallet)).toBase58();
    return (await getTokenAccountBalance(ata)).uiAmount;
  } catch (e) {
    return /could not find account/i.test(errMsg(e)) ? 0 : null;
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const limited = readLimiter.check(request);
  if (limited) return limited;
  if (!envFlag('SOLANA_POOL_ENABLED')) return NextResponse.json({ enabled: false });
  const wallet = (request.nextUrl.searchParams.get('wallet') || '').trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) {
    return NextResponse.json({ error: 'invalid wallet' }, { status: 400 });
  }
  try {
    const { getWalletSharesRaw, getTotalSharesRaw, getAccountedTokensRaw } = await import(
      '@/lib/db/solana-pool'
    );
    const { toUi, payoutForShares } = await import('@/lib/services/solana/pool-state');

    const [owned, total, accounted] = await Promise.all([
      getWalletSharesRaw(wallet),
      getTotalSharesRaw(),
      getAccountedTokensRaw(),
    ]);
    const valueRaw = payoutForShares(owned, accounted, total);
    return NextResponse.json({
      wallet,
      sharesUi: toUi(owned),
      tokenValueUi: toUi(valueRaw),
      poolSharePct: total > 0n ? Number((owned * 10_000n) / total) / 100 : 0,
      walletTokenUi: await walletTokenBalanceUi(wallet),
    });
  } catch (e) {
    logger.warn('[SolanaPool] balance read failed', { error: errMsg(e) });
    return NextResponse.json({ error: 'your pool position could not be read right now' }, { status: 500 });
  }
}
