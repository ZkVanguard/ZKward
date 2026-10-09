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
const NAV_SNAPSHOT_MS = 15 * 60_000;
/** About 4,000 payouts' worth of base fees; a new recipient's token account costs about 0.002 SOL more. */
const LOW_FEE_LAMPORTS = 20_000_000;

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
  const { claimed } = await tryClaimCronRun(CLAIM_KEY, CLAIM_MS, now);
  if (!claimed) {
    return NextResponse.json({ enabled: true, claimed: false });
  }

  after(async () => {
    try {
      const { runSolanaPoolIndexTick, reconcilePendingWithdrawals, solanaCluster } = await import(
        '@/lib/services/solana/SolanaPoolService'
      );
      const { notifyDiscord } = await import('@/lib/utils/discord-notify');
      const cluster = solanaCluster();

      // Payouts whose request ended before the chain answered: settle the
      // ones that landed, give the shares back for the ones that cannot.
      // Before the index tick, so the valuation below sees the result.
      const payouts = await reconcilePendingWithdrawals().catch((e) => {
        logger.warn('[SolanaPool] pending-withdrawal pass failed', { error: errMsg(e) });
        return null;
      });

      const summary = await runSolanaPoolIndexTick();
      await setCronState('cron:lastRun:solana-pool', Date.now());
      if (summary.credited > 0) {
        void notifyDiscord(
          `[SolanaPool] ${summary.credited} deposit(s) credited · shares ${summary.totalSharesRaw} · vault ${summary.vaultTokensRaw} (${cluster})`,
          'INFO',
          { chain: 'solana' },
        );
      }

      // Two conditions that stop payouts, said out loud: the vault holding
      // less than the ledger owes, and the vault running out of fee money.
      try {
        const db = await import('@/lib/db/solana-pool');
        const accounted = await db.getAccountedTokensRaw();
        if (summary.vaultTokensRaw !== 'unavailable' && BigInt(summary.vaultTokensRaw) < accounted) {
          void notifyDiscord(
            `[SolanaPool] vault holds less than the ledger owes on ${cluster}: withdrawals are refused until this is resolved`,
            'ERROR',
            { chain: 'solana', vaultTokensRaw: summary.vaultTokensRaw, accountedTokensRaw: accounted.toString() },
          );
        }
        const vaultOwner = (process.env.SOLANA_POOL_VAULT || '').trim();
        if (vaultOwner) {
          const { getLamports } = await import('@/lib/services/solana/rpc');
          const lamports = await getLamports(vaultOwner);
          if (lamports < LOW_FEE_LAMPORTS) {
            void notifyDiscord(
              `[SolanaPool] vault fee balance is low on ${cluster}: top it up or payouts will fail`,
              'WARN',
              { chain: 'solana', sol: lamports / 1e9 },
            );
          }
        }
      } catch (e) {
        logger.warn('[SolanaPool] solvency and fee check failed (indexer unaffected)', { error: errMsg(e) });
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

      // NAV history for the dashboard chart — one snapshot per 15 min.
      try {
        const { claimed: snapshotDue } = await tryClaimCronRun('solana-pool:nav-snapshot', NAV_SNAPSHOT_MS, Date.now());
        if (snapshotDue) {
          const db = await import('@/lib/db/solana-pool');
          const { getPoolTokenUsdPrice } = await import('@/lib/services/solana/price');
          const { ledgerValuation } = await import('@/lib/services/solana/pool-state');
          const [accountedTokensRaw, totalSharesRaw, price] = await Promise.all([
            db.getAccountedTokensRaw(),
            db.getTotalSharesRaw(),
            getPoolTokenUsdPrice(),
          ]);
          await db.recordNavSnapshot({
            ...ledgerValuation(accountedTokensRaw, totalSharesRaw, price?.usd ?? null),
            accountedTokensRaw,
            totalSharesRaw,
          });
        }
      } catch (e) {
        logger.warn('[SolanaPool] NAV snapshot failed (indexer unaffected)', { error: errMsg(e) });
      }

      logger.info('[SolanaPool] tick complete', { ...summary, sleeve, payouts });
    } catch (e) {
      logger.error('[SolanaPool] tick failed', { error: errMsg(e) });
      // A tick that cannot run credits no deposits. The alert layer holds repeats.
      try {
        const { notifyDiscord } = await import('@/lib/utils/discord-notify');
        void notifyDiscord('[SolanaPool] index tick failed: deposits are not being credited', 'ERROR', { chain: 'solana', error: errMsg(e).slice(0, 200) });
      } catch { /* the log line above stands */ }
    }
  });

  return NextResponse.json({ enabled: true, claimed: true, acked: true }, { status: 202 });
}
