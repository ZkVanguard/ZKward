/**
 * Hedges query scope helpers — enforce the "real hedges only" filter at
 * query authoring time.
 *
 * The `hedges` table is shared between the live trader (portfolio -1 SUI
 * pool, -2 SUI treasury, chain='sui', simulation_mode=false) and the paper
 * trader (portfolio -3, chain='hedera-testnet', simulation_mode=true).
 *
 * When a query intended for live-trader accounting or decision-making
 * forgets to filter out paper trades, the results silently include the
 * paper trader's simulated PnL. Every occurrence found in 2026-09-18:
 *
 *   - PR #128: lib/services/paper-trader/PaperTrader.ts closeAtMark was
 *     writing paper closes to treasury_ledger. 126 rows / -$62,158.96 of
 *     fake losses hit the real accounting ledger.
 *
 *   - PR #131: app/api/cron/polymarket-edge-trader/route.ts:340
 *     regretBasedHalt sampled 200 recent closed hedges (paper included).
 *     Live trader was regret-halted for hours because paper had 138
 *     closed trades / 25% win rate in the same 30-day window.
 *
 *   - PR #131: lib/services/ai/agent-tools.ts:118 get_hedge_history LLM
 *     tool returned paper trades to the reasoning agent, poisoning its
 *     judgment about live-trader performance.
 *
 * Root cause: `simulation_mode = false` was hand-rolled in ~21 files.
 * Every new query is a fresh opportunity to forget. This module makes
 * the filter a one-import primitive.
 *
 * ## Usage
 *
 *   // Inline in a raw SQL literal:
 *   const rows = await query(
 *     `SELECT * FROM hedges WHERE status = 'closed' AND ${HEDGES_REAL_ONLY_SQL}`,
 *   );
 *
 *   // As a helper for count / aggregate:
 *   const { total } = await queryOne(realHedgesSql(
 *     `SELECT COUNT(*)::text AS total FROM hedges WHERE status = 'closed'`,
 *   ));
 *
 * ## Design choice
 *
 * The primitive is a SQL fragment, not a wrapper function. Wrapping the
 * whole query in a helper would force a rewrite of every call site's
 * shape (return type, param handling, join structure). A drop-in string
 * clause keeps migrations to a one-line diff at each site.
 */

/**
 * Canonical "real hedges only" SQL clause. Combine with `AND` in any
 * WHERE clause that queries the hedges table for accounting, PnL,
 * regret, or decision-making purposes.
 *
 * Deliberately checks `simulation_mode = false` explicitly (NOT `IS NOT
 * TRUE`) — this matches how paper rows are written (createHedge passes
 * `simulationMode: true`) and doesn't accidentally include rows with
 * NULL simulation_mode. Every current row has an explicit boolean; a
 * NULL would be a data integrity bug we want to surface, not paper over.
 */
export const HEDGES_REAL_ONLY_SQL = 'simulation_mode = false';

/**
 * Splice the "real hedges only" clause into an existing WHERE. Handy
 * when the SQL is built as a single string and appending `AND ...`
 * would require care about existing clauses.
 *
 * Example:
 *   realHedgesSql(`SELECT * FROM hedges WHERE status = 'closed'`)
 *   →  `SELECT * FROM hedges WHERE status = 'closed' AND simulation_mode = false`
 *
 * If there's no WHERE clause, appends `WHERE ${clause}`.
 */
export function realHedgesSql(sql: string): string {
  const hasWhere = /\bWHERE\b/i.test(sql);
  if (hasWhere) return `${sql} AND ${HEDGES_REAL_ONLY_SQL}`;
  return `${sql} WHERE ${HEDGES_REAL_ONLY_SQL}`;
}
