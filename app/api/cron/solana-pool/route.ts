/**
 * Cron: solana-pool — deposit indexer tick for the Solana token pool.
 *
 * Independent vertical (own jobs-service schedule, NOT in master's fanout):
 * a master outage and a Solana-pool outage cannot cause each other.
 *
 * Dark-shipped: without SOLANA_POOL_ENABLED=1 this is a 200 no-op — merging
 * never activates anything (plan §1e). 4xx is deliberately avoided for the
 * disabled state so scheduler delivery/monitoring never sees it as failure.
 *
 * Ack-and-run: 202 immediately, work in `after()` — awaiting in-request is
 * how the fast-tick earned 98 delivery-retry re-runs a day.
 */

import { NextRequest, NextResponse, after } from 'next/server';
import { logger } from '@/lib/utils/logger';
import { verifyCronRequest } from '@/lib/qstash';
import { errMsg } from '@/lib/utils/error-handler';
import { envFlag } from '@/lib/utils/env-flag';
import { setCronState, tryClaimCronRun } from '@/lib/db/cron-state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const CLAIM_KEY = 'solana-pool:tick-claim';
const CLAIM_MS = 55_000;

export async function GET(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}

async function handle(request: NextRequest): Promise<NextResponse> {
  const auth = await verifyCronRequest(request, 'SolanaPool');
  if (auth instanceof NextResponse) return auth;

  if (!envFlag('SOLANA_POOL_ENABLED')) {
    return NextResponse.json({ enabled: false });
  }

  const now = Date.now();
  const claimed = await tryClaimCronRun(CLAIM_KEY, CLAIM_MS, now);
  if (!claimed) {
    return NextResponse.json({ enabled: true, claimed: false });
  }

  after(async () => {
    try {
      const { runSolanaPoolIndexTick } = await import(
        '@/lib/services/solana/SolanaPoolService'
      );
      const summary = await runSolanaPoolIndexTick();
      await setCronState('cron:lastRun:solana-pool', Date.now());
      if (summary.credited > 0) {
        const { notifyDiscord } = await import('@/lib/utils/discord-notify');
        void notifyDiscord(
          `[SolanaPool] ${summary.credited} deposit(s) credited · shares ${summary.totalSharesRaw} · vault ${summary.vaultTokensRaw} (${(process.env.SOLANA_CLUSTER || 'devnet').trim()})`,
          'INFO',
        );
      }

      // Sleeve trader — the pool's win-rate engine (plan §1b portfolio
      // margin: sleeve notional tracks live pool NAV in USD).
      let sleeve: unknown = null;
      try {
        const { getPoolTokenUsdPrice } = await import('@/lib/services/solana/price');
        const { toUi } = await import('@/lib/services/solana/pool-state');
        const { runSolanaSleeveTick } = await import(
          '@/lib/services/solana/SolanaSleeveTrader'
        );
        const price = await getPoolTokenUsdPrice();
        const navUsd =
          summary.vaultTokensRaw !== 'unavailable' && price
            ? toUi(BigInt(summary.vaultTokensRaw)) * price.usd
            : null;
        sleeve = await runSolanaSleeveTick(navUsd);
      } catch (e) {
        logger.warn('[SolanaPool] sleeve tick failed (indexer unaffected)', {
          error: errMsg(e),
        });
      }

      logger.info('[SolanaPool] tick complete', { ...summary, sleeve });
    } catch (e) {
      logger.error('[SolanaPool] tick failed', { error: errMsg(e) });
    }
  });

  return NextResponse.json({ enabled: true, claimed: true, acked: true }, { status: 202 });
}
