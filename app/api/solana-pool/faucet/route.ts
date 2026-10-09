/**
 * Devnet faucet — mints mirror JIMP so anyone can demo deposit/withdraw.
 *
 * Physically testnet-only twice over: a hard cluster guard here, and the
 * capability itself (the REAL mainnet JIMP has renounced mint authority,
 * so this endpoint cannot exist for it). Per-wallet cooldown via
 * cron_state.
 */
import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/utils/logger';
import { errMsg } from '@/lib/utils/error-handler';
import { envFlag } from '@/lib/utils/env-flag';
import { getCronState, setCronState } from '@/lib/db/cron-state';
import { mutationLimiter } from '@/lib/security/rate-limiter';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const AMOUNT_UI = 100_000;
const COOLDOWN_MS = 60 * 60 * 1000;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const limited = mutationLimiter.check(request);
  if (limited) return limited;
  if (!envFlag('SOLANA_POOL_ENABLED')) {
    return NextResponse.json({ error: 'pool disabled' }, { status: 404 });
  }
  // Allowed by name. Refusing mainnet by name left the faucet open to any
  // other spelling of the cluster; an unknown value throws inside.
  const { solanaCluster } = await import('@/lib/services/solana/cluster');
  let cluster: string;
  try {
    cluster = solanaCluster();
  } catch {
    return NextResponse.json({ error: 'faucet is testnet-only' }, { status: 403 });
  }
  if (cluster !== 'devnet' && cluster !== 'testnet') {
    return NextResponse.json({ error: 'faucet is testnet-only' }, { status: 403 });
  }
  try {
    const { wallet } = (await request.json()) as { wallet?: string };
    const w = (wallet || '').trim();
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(w)) {
      return NextResponse.json({ error: 'invalid wallet' }, { status: 400 });
    }
    const key = `solana-pool:faucet:${w}`;
    const last = await getCronState<number>(key);
    if (last && Date.now() - last < COOLDOWN_MS) {
      const mins = Math.ceil((COOLDOWN_MS - (Date.now() - last)) / 60_000);
      return NextResponse.json({ error: `cooldown — try again in ~${mins} min` }, { status: 429 });
    }

    const { mintTestTokens } = await import('@/lib/services/solana/signer');
    const { fromUi } = await import('@/lib/services/solana/pool-state');
    const txSignature = await mintTestTokens(w, fromUi(AMOUNT_UI));
    await setCronState(key, Date.now());

    logger.info('[SolanaPool] faucet mint', { wallet: w.slice(0, 8), amountUi: AMOUNT_UI });
    return NextResponse.json({ txSignature, amountUi: AMOUNT_UI });
  } catch (e) {
    logger.warn('[SolanaPool] faucet failed', { error: errMsg(e) });
    return NextResponse.json({ error: 'the faucet could not send test tokens right now — try again in a minute' }, { status: 500 });
  }
}
