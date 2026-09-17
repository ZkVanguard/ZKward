/**
 * Treasury status CLI — snapshot of what the agent has, spent, and can afford.
 *
 * Runs:
 *   bun run treasury:status              → snapshot only
 *   bun run treasury:status --reconcile  → sweep closed hedges first, then snapshot
 *
 * Read-only (except when --reconcile is passed, which INSERTs new pnl_credit
 * rows from closed hedges — idempotent via unique constraint on order_id).
 */
import {
  getTreasuryState,
  reconcileFromHedges,
  runwayMonths,
} from '@/lib/db/treasury';

function fmt(n: number): string {
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

async function main() {
  const doReconcile = process.argv.includes('--reconcile');
  if (doReconcile) {
    const r = await reconcileFromHedges();
    console.log(`Reconciled from hedges — credited: ${r.credited}, skipped (already recorded): ${r.skipped}`);
  }

  const s = await getTreasuryState();
  const monthlyBurn = Number(process.env.TREASURY_MONTHLY_BURN_USD || 0);
  const runway = monthlyBurn > 0 ? runwayMonths(s, monthlyBurn) : null;

  console.log('');
  console.log('── Treasury snapshot ──────────────────────────────');
  console.log(`Cumulative P&L:      ${fmt(s.totalPnlUsd).padStart(14)}`);
  console.log(`Operational spend:   ${fmt(s.totalOpsUsd).padStart(14)}`);
  console.log(`Reinvestment spend:  ${fmt(s.totalReinvestUsd).padStart(14)}`);
  console.log(`Buffer reserve:      ${fmt(-s.bufferUsd).padStart(14)}`);
  console.log('                     ──────────────');
  console.log(`Free balance:        ${fmt(s.freeBalanceUsd).padStart(14)}   ${s.healthy ? '✓ healthy' : '✗ UNDERWATER'}`);
  console.log('');
  console.log(`Ledger entries:      ${s.entries}`);
  if (runway !== null) {
    console.log(`Runway at $${monthlyBurn}/mo:  ${runway.toFixed(1)} months`);
  } else if (monthlyBurn > 0) {
    console.log(`Runway at $${monthlyBurn}/mo:  0 (underwater)`);
  } else {
    console.log(`(set TREASURY_MONTHLY_BURN_USD to see runway)`);
  }
  console.log('');
  console.log(`As of:               ${s.updatedAt}`);
}

main().catch((err) => {
  console.error('[treasury:status] fatal', err);
  process.exit(1);
});
