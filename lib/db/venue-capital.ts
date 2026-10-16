/**
 * Capital moved to or from the venue account, one row per chain transaction.
 *
 * The venue's settled equity changes only by these moves and by settled
 * trade results, so with this ledger the account can be explained from rows.
 * Until 2026-10 no move was recorded: $66.77 went in over 20 deposits and the
 * books could not say where the account's value came from.
 *
 * A money record: never pruned.
 */
import { query } from './postgres';

export type VenueCapitalKind = 'deposit' | 'withdrawal';

let ready = false;
async function ensureTable(): Promise<void> {
  if (ready) return;
  await query(`
    CREATE TABLE IF NOT EXISTS venue_capital (
      id          SERIAL PRIMARY KEY,
      ts          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      kind        VARCHAR(16) NOT NULL CHECK (kind IN ('deposit', 'withdrawal')),
      amount_usd  DECIMAL(20, 6) NOT NULL CHECK (amount_usd > 0),
      tx_digest   VARCHAR(128) NOT NULL UNIQUE,
      note        TEXT
    )
  `);
  ready = true;
}

/** Idempotent per transaction. Throws on a database error: the caller decides how loud to be. */
export async function recordVenueCapital(kind: VenueCapitalKind, amountUsd: number, txDigest: string, note?: string): Promise<void> {
  if (!(amountUsd > 0) || !txDigest) throw new Error(`venue capital needs a positive amount and a digest (${amountUsd}, ${txDigest})`);
  await ensureTable();
  await query(
    `INSERT INTO venue_capital (kind, amount_usd, tx_digest, note) VALUES ($1, $2, $3, $4)
     ON CONFLICT (tx_digest) DO NOTHING`,
    [kind, amountUsd, txDigest, note ?? null],
  );
}

