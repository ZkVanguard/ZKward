/**
 * Treasury ledger — economic-sustenance layer for the autonomous agent.
 *
 * ## Why this exists
 *
 * An agent that can't pay its own bills doesn't persist. This module
 * consolidates every dollar in (realized P&L from hedges) and every
 * dollar out (Vercel functions, ASI credits, Aiven, training runs,
 * bounties) into a single ledger. The agent reads its own balance via
 * the `get_treasury_state` Layer 3 tool and decides accordingly.
 *
 * ## Claim ordering
 *
 *   1. Operational costs come first (system must keep running)
 *   2. Buffer reserve (drawdown protection, default $100)
 *   3. Reinvestment (training, data, bounties)
 *
 * Free balance = totalPnl − totalOps − buffer − totalReinvest.
 * If negative → system halts new reinvestment proposals.
 *
 * ## Idempotency
 *
 * Every entry has a (category, subcategory, reference) unique triple —
 * re-recording the same hedge close or the same monthly bill is a no-op.
 * Hedge close reconciler can safely call `recordPnlCredit` on every tick.
 *
 * ## What this is NOT
 *
 * Not a wallet. Not a payment gateway. Just accounting — records what
 * happened. The actual wallet moves (paying Vercel, receiving hedge
 * settlements) happen elsewhere. This is the memory that lets the
 * agent reason about its own economic state.
 */

import { query } from '@/lib/db/postgres';
import { logger } from '@/lib/utils/logger';

const DEFAULT_BUFFER_USD = 100;

export type LedgerCategory = 'pnl_credit' | 'ops_debit' | 'reinvest_debit' | 'buffer_adjust';

let tableReady = false;

export async function ensureTreasuryTable(): Promise<void> {
  if (tableReady) return;
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS treasury_ledger (
        id           SERIAL PRIMARY KEY,
        ts           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        category     VARCHAR(32) NOT NULL CHECK (category IN ('pnl_credit','ops_debit','reinvest_debit','buffer_adjust')),
        subcategory  VARCHAR(64) NOT NULL,
        amount_usd   DECIMAL(20, 6) NOT NULL,
        reference    VARCHAR(128),
        note         TEXT,
        metadata     JSONB NOT NULL DEFAULT '{}',
        UNIQUE (category, subcategory, reference)
      );
      CREATE INDEX IF NOT EXISTS idx_treasury_ledger_ts ON treasury_ledger(ts DESC);
      CREATE INDEX IF NOT EXISTS idx_treasury_ledger_category ON treasury_ledger(category);
    `);
    tableReady = true;
  } catch (err) {
    logger.warn('[Treasury] ensureTable failed', {
      error: err instanceof Error ? err.message : err,
    });
    tableReady = true;
  }
}

// ── Write path ────────────────────────────────────────────────────────

interface WriteArgs {
  subcategory: string;
  amountUsd: number;
  reference?: string | null;
  note?: string;
  metadata?: Record<string, unknown>;
}

async function record(category: LedgerCategory, args: WriteArgs): Promise<boolean> {
  await ensureTreasuryTable();
  const amount = Number(args.amountUsd);
  if (!Number.isFinite(amount) || amount === 0) return false;
  try {
    const result = await query<{ id: number }>(
      `INSERT INTO treasury_ledger (category, subcategory, amount_usd, reference, note, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (category, subcategory, reference) DO NOTHING
       RETURNING id`,
      [category, args.subcategory, amount, args.reference ?? null, args.note ?? null, JSON.stringify(args.metadata ?? {})],
    );
    return result.length > 0;
  } catch (err) {
    logger.warn('[Treasury] record failed', {
      category,
      subcategory: args.subcategory,
      error: err instanceof Error ? err.message : err,
    });
    return false;
  }
}

/** Record a realized hedge P&L as income. Idempotent per orderId.
 *  Signed: profitable close = positive amountUsd; losing close = negative. */
export function recordPnlCredit(
  orderId: string,
  realizedPnlUsd: number,
  note?: string,
): Promise<boolean> {
  return record('pnl_credit', {
    subcategory: 'hedge_close',
    amountUsd: realizedPnlUsd,
    reference: orderId,
    note,
  });
}

/** Record an operational cost. Sign convention: pass positive amountUsd —
 *  the reporter converts to negative internally for balance calculation. */
export function recordOpsDebit(args: {
  subcategory: 'vercel' | 'asi' | 'aiven' | 'qstash' | 'discord' | 'sui_gas' | 'other';
  amountUsd: number;
  invoiceId: string;
  note?: string;
}): Promise<boolean> {
  return record('ops_debit', {
    subcategory: args.subcategory,
    amountUsd: -Math.abs(args.amountUsd),
    reference: args.invoiceId,
    note: args.note,
  });
}

/** Record a reinvestment cost. Same sign convention as ops. */
export function recordReinvestment(args: {
  subcategory: 'training_run' | 'data_source' | 'bounty' | 'compute_rental' | 'other';
  amountUsd: number;
  referenceId: string;
  note?: string;
  metadata?: Record<string, unknown>;
}): Promise<boolean> {
  return record('reinvest_debit', {
    subcategory: args.subcategory,
    amountUsd: -Math.abs(args.amountUsd),
    reference: args.referenceId,
    note: args.note,
    metadata: args.metadata,
  });
}

// ── Read path ─────────────────────────────────────────────────────────

export interface TreasuryState {
  totalPnlUsd: number;
  totalOpsUsd: number;         // negative (spend)
  totalReinvestUsd: number;    // negative (spend)
  bufferUsd: number;           // reserve (positive)
  freeBalanceUsd: number;      // totalPnl + totalOps + totalReinvest - buffer
  healthy: boolean;            // freeBalance > 0
  entries: number;
  updatedAt: string;
}

/** Snapshot of current state. Reads the full ledger — cheap at demo scale
 *  (few hundred rows), can be indexed if it grows. */
export async function getTreasuryState(): Promise<TreasuryState> {
  await ensureTreasuryTable();
  const bufferUsd = Number(process.env.TREASURY_BUFFER_USD || DEFAULT_BUFFER_USD);
  try {
    const rows = await query<{ category: string; total: string; n: string }>(
      `SELECT category, COALESCE(SUM(amount_usd), 0)::text AS total, COUNT(*)::text AS n
       FROM treasury_ledger
       GROUP BY category`,
    );
    const by: Record<string, number> = {};
    let n = 0;
    for (const r of rows) {
      by[r.category] = Number(r.total);
      n += Number(r.n);
    }
    const totalPnlUsd = by['pnl_credit'] ?? 0;
    const totalOpsUsd = by['ops_debit'] ?? 0;         // already negative
    const totalReinvestUsd = by['reinvest_debit'] ?? 0; // already negative
    const freeBalanceUsd = totalPnlUsd + totalOpsUsd + totalReinvestUsd - bufferUsd;
    return {
      totalPnlUsd,
      totalOpsUsd,
      totalReinvestUsd,
      bufferUsd,
      freeBalanceUsd,
      healthy: freeBalanceUsd > 0,
      entries: n,
      updatedAt: new Date().toISOString(),
    };
  } catch (err) {
    logger.warn('[Treasury] getTreasuryState failed', {
      error: err instanceof Error ? err.message : err,
    });
    return {
      totalPnlUsd: 0,
      totalOpsUsd: 0,
      totalReinvestUsd: 0,
      bufferUsd,
      freeBalanceUsd: -bufferUsd,
      healthy: false,
      entries: 0,
      updatedAt: new Date().toISOString(),
    };
  }
}

/** Runway at a given monthly burn rate. Returns null when free balance
 *  is negative or burn rate is nonpositive. */
export function runwayMonths(state: TreasuryState, monthlyBurnUsd: number): number | null {
  if (state.freeBalanceUsd <= 0 || monthlyBurnUsd <= 0) return null;
  return state.freeBalanceUsd / monthlyBurnUsd;
}

/** Gate for reinvestment proposals. Returns true if the proposed spend
 *  still leaves a positive free balance after execution. */
export function canAffordReinvestment(
  state: TreasuryState,
  proposedSpendUsd: number,
): boolean {
  return state.freeBalanceUsd - Math.abs(proposedSpendUsd) > 0;
}

// ── Reconciliation from hedges ────────────────────────────────────────

/** Sweep closed hedges since a checkpoint and credit their realized P&L
 *  to the treasury. Idempotent — orderId is the unique key. Returns how
 *  many new credits were applied. */
export async function reconcileFromHedges(): Promise<{ credited: number; skipped: number }> {
  await ensureTreasuryTable();
  try {
    // simulation_mode = false excludes the paper trader (portfolio -3,
    // chain hedera-testnet). Diagnosed 2026-09-18: reconciler was pulling
    // in 126 paper closes and crediting them to the real treasury via
    // recordPnlCredit — same root cause as the closeAtMark leak. Belt +
    // braces so a future re-run doesn't undo the manual cleanup.
    const closed = await query<{ order_id: string; realized_pnl: string }>(
      `SELECT order_id, realized_pnl
       FROM hedges
       WHERE status = 'closed'
         AND simulation_mode = false
         AND realized_pnl IS NOT NULL
         AND ABS(realized_pnl) > 0.01`,
    );
    let credited = 0;
    let skipped = 0;
    for (const row of closed) {
      const inserted = await recordPnlCredit(row.order_id, Number(row.realized_pnl));
      if (inserted) credited++;
      else skipped++;
    }
    return { credited, skipped };
  } catch (err) {
    logger.warn('[Treasury] reconcileFromHedges failed', {
      error: err instanceof Error ? err.message : err,
    });
    return { credited: 0, skipped: 0 };
  }
}
