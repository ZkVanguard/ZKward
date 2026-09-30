/**
 * Solana pool indexer — read-only deposit crediting.
 *
 * Flow per tick: fetch signatures on the vault ATA newer than the watermark
 * (cron_state `solana-pool:last-sig`) → parse each confirmed tx → credit
 * SPL transfers into the vault as deposits, minting shares at the current
 * ledger share price (see pool-state for why never the chain balance). Signature
 * PK makes every step replay-safe; the watermark is an optimization, not a
 * correctness requirement.
 */
import { getCronState, setCronState } from '@/lib/db/cron-state';
import { logger } from '@/lib/utils/logger';
import {
  getSignaturesForAddress,
  getTransaction,
  getTokenAccountBalance,
  extractDepositsToVault,
} from './rpc';
import { sharesForDeposit } from './pool-state';
import { recordDeposit, getTotalSharesRaw, getAccountedTokensRaw } from '@/lib/db/solana-pool';

const KEY_LAST_SIG = 'solana-pool:last-sig';
const FIRST_RUN_LIMIT = 50;

export function solanaCluster(): string {
  return (process.env.SOLANA_CLUSTER || 'devnet').trim();
}

export function vaultAta(): string {
  return (process.env.SOLANA_POOL_VAULT_ATA || '').trim();
}

export interface IndexTickSummary {
  scanned: number;
  credited: number;
  skipped: number;
  vaultTokensRaw: string;
  totalSharesRaw: string;
}

export async function runSolanaPoolIndexTick(): Promise<IndexTickSummary> {
  const ata = vaultAta();
  if (!ata) throw new Error('SOLANA_POOL_VAULT_ATA not configured');

  const until = (await getCronState<string>(KEY_LAST_SIG)) ?? undefined;
  const sigs = await getSignaturesForAddress(ata, { until, limit: FIRST_RUN_LIMIT });

  // Oldest first so shares mint in deposit order and the watermark only
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
            cluster: solanaCluster(),
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
  // One watermark write per tick — mid-loop crashes just re-scan; the
  // signature PK turns reprocessing into no-ops.
  if (ordered.length > 0) {
    await setCronState(KEY_LAST_SIG, ordered[ordered.length - 1].signature);
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
