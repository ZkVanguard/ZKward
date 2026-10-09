/**
 * Solana pool indexer — read-only deposit crediting, and the settlement of
 * payouts whose outcome was not known when the request ended.
 *
 * Flow per tick: fetch every finalized signature on the vault ATA newer than
 * the mark (cron_state `solana-pool:last-sig:<cluster>`) → parse each tx →
 * credit SPL transfers into the vault as deposits, minting shares at the
 * current ledger share price (see pool-state for why never the chain
 * balance). The signature PK makes every step replay-safe; the mark is an
 * optimization, not a correctness requirement.
 */
import { getCronState, setCronState } from '@/lib/db/cron-state';
import { logger } from '@/lib/utils/logger';
import {
  getSignaturesForAddress,
  getTransaction,
  getTokenAccountBalance,
  getSignatureStatus,
  getFinalizedBlockHeight,
  extractDepositsToVault,
  type SignatureInfo,
} from './rpc';
import { sharesForDeposit, fromUi } from './pool-state';
import { envFlag } from '@/lib/utils/env-flag';
import { solanaCluster } from './cluster';
import {
  recordDeposit,
  getTotalSharesRaw,
  getAccountedTokensRaw,
  getPendingWithdrawals,
  settleWithdrawal,
  releaseWithdrawal,
  isUnsigned,
  type PendingWithdrawal,
} from '@/lib/db/solana-pool';

const PAGE = 1000;
// ponytail: 20,000 signatures a tick. More than that in one minute is a
// flood; the tick stops without moving the mark and says so. Raise it, or
// process oldest-first in slices, if real volume ever gets near.
const MAX_PAGES = 20;

/** A reservation that never got a signature was never sent: safe to give back after this long. */
const UNSIGNED_RELEASE_SEC = 120;

export { solanaCluster };

export function vaultAta(): string {
  return (process.env.SOLANA_POOL_VAULT_ATA || '').trim();
}

// ── Operator limits (all optional; unset = no limit) ─────────────────

const tokensEnv = (name: string): bigint | null => {
  const v = Number((process.env[name] || '').trim());
  return Number.isFinite(v) && v > 0 ? fromUi(v) : null;
};

/** The switch that stops payouts without a deploy. Deposits are on-chain transfers and cannot be stopped here. */
export const withdrawalsPaused = (): boolean => envFlag('SOLANA_POOL_WITHDRAWALS_PAUSED');

/** Largest single payout, in raw token units. Bounds what one request can take from the hot vault. */
export const maxWithdrawRaw = (): bigint | null => tokensEnv('SOLANA_POOL_MAX_WITHDRAW_TOKENS');

/** Pool size above which the page stops offering deposits, in raw token units. */
export const depositCapRaw = (): bigint | null => tokensEnv('SOLANA_POOL_DEPOSIT_CAP_TOKENS');

export interface IndexTickSummary {
  scanned: number;
  credited: number;
  skipped: number;
  vaultTokensRaw: string;
  totalSharesRaw: string;
}

/**
 * Every signature newer than `until`, newest first. One page used to be
 * all that was read, and the mark then jumped to the newest: a busy minute
 * left the older deposits behind it for good.
 */
export async function signaturesSince(address: string, until: string | undefined): Promise<SignatureInfo[]> {
  const all: SignatureInfo[] = [];
  let before: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await getSignaturesForAddress(address, { until, before, limit: PAGE });
    all.push(...batch);
    if (batch.length < PAGE) return all;
    before = batch[batch.length - 1].signature;
  }
  throw new Error(`more than ${MAX_PAGES * PAGE} new signatures on the vault: mark not moved`);
}

export async function runSolanaPoolIndexTick(): Promise<IndexTickSummary> {
  const ata = vaultAta();
  if (!ata) throw new Error('SOLANA_POOL_VAULT_ATA not configured');

  const markKey = `solana-pool:last-sig:${solanaCluster()}`;
  // The devnet pool's mark predates the per-cluster key. Reading it once
  // saves a rescan of the whole devnet history through a rate-limited
  // public endpoint; the first tick writes the new key.
  const until =
    (await getCronState<string>(markKey)) ??
    (solanaCluster() === 'devnet' ? await getCronState<string>('solana-pool:last-sig') : null) ??
    undefined;
  const sigs = await signaturesSince(ata, until);

  // Oldest first so shares mint in deposit order and the mark only
  // advances past fully-processed transactions.
  const ordered = [...sigs].reverse();
  let credited = 0;
  let skipped = 0;

  for (const s of ordered) {
    if (s.err) {
      skipped++;
    } else {
      const tx = await getTransaction(s.signature);
      const deposits = tx ? extractDepositsToVault(tx, ata) : [];
      if (deposits.length === 0) {
        skipped++;
      } else {
        for (const d of deposits) {
          // Mint at the LEDGER price (accounted tokens / shares), re-read per
          // deposit so multiple deposits in one tick price sequentially.
          const [accounted, totalShares] = await Promise.all([
            getAccountedTokensRaw(),
            getTotalSharesRaw(),
          ]);
          const shares = sharesForDeposit(d.rawAmount, accounted, totalShares);
          const isNew = await recordDeposit({
            signature: s.signature,
            sender: d.authority || d.source,
            amountRaw: d.rawAmount,
            sharesMintedRaw: shares,
            slot: tx!.slot,
            blockTime: tx!.blockTime,
          });
          if (isNew) {
            credited++;
            logger.info('[SolanaPool] deposit credited', {
              signature: s.signature.slice(0, 16),
              sender: (d.authority || d.source).slice(0, 8),
              amountRaw: d.rawAmount.toString(),
            });
          }
        }
      }
    }
  }
  // One mark write per tick — mid-loop crashes just re-scan; the
  // signature PK turns reprocessing into no-ops.
  if (ordered.length > 0) {
    await setCronState(markKey, ordered[ordered.length - 1].signature);
  }

  const [balance, totalShares] = await Promise.all([
    getTokenAccountBalance(ata).catch(() => null),
    getTotalSharesRaw(),
  ]);

  return {
    scanned: sigs.length,
    credited,
    skipped,
    vaultTokensRaw: balance?.amount ?? 'unavailable',
    totalSharesRaw: totalShares.toString(),
  };
}

export type PayoutOutcome = 'paid' | 'released' | 'pending';

/**
 * Decide a reserved payout from what the chain shows, and write the answer.
 *   paid     — the transfer is confirmed: the burn stands;
 *   released — it failed, or its blockhash expired unseen: the shares return;
 *   pending  — it may still land: the shares stay burned and it is asked again.
 * A failed chain read throws and decides nothing.
 */
export async function resolvePayout(w: Pick<PendingWithdrawal, 'signature' | 'lastValidBlockHeight' | 'ageSeconds'>): Promise<PayoutOutcome> {
  if (isUnsigned(w.signature)) {
    if (w.ageSeconds < UNSIGNED_RELEASE_SEC) return 'pending';
    await releaseWithdrawal(w.signature);
    return 'released';
  }
  const status = await getSignatureStatus(w.signature);
  if (status) {
    if (status.err) {
      await releaseWithdrawal(w.signature);
      return 'released';
    }
    if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
      await settleWithdrawal(w.signature);
      return 'paid';
    }
    return 'pending';
  }
  // Unseen. It can still land until the finalized chain passes its last valid height.
  if (w.lastValidBlockHeight !== null && (await getFinalizedBlockHeight()) > w.lastValidBlockHeight) {
    await releaseWithdrawal(w.signature);
    return 'released';
  }
  return 'pending';
}

/** Settle or release every payout left pending by a request that ended before the chain answered. */
export async function reconcilePendingWithdrawals(): Promise<{ paid: number; released: number; pending: number }> {
  const counts = { paid: 0, released: 0, pending: 0 };
  for (const w of await getPendingWithdrawals()) {
    try {
      const outcome = await resolvePayout(w);
      counts[outcome]++;
      if (outcome !== 'pending') {
        logger.info('[SolanaPool] pending withdrawal resolved', { outcome, wallet: w.wallet.slice(0, 8), signature: w.signature.slice(0, 16) });
      }
    } catch (e) {
      counts.pending++;
      logger.warn('[SolanaPool] pending withdrawal not resolved this tick', { error: e instanceof Error ? e.message : String(e) });
    }
  }
  return counts;
}
