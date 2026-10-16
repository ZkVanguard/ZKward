/**
 * Open paper positions, marked on their rows every tick, and a warning when a
 * strategy book holds one past its stop or its time limit.
 *
 * The books keep their marks in memory, so a row showed 0 while a long sat at
 * -500 bp behind a -200 bp stop (2026-10-09). The mark on the row makes that
 * visible; the warning catches a book that stopped managing its exits.
 * The Solana sleeve (-6) stays in its own vertical.
 */
import { query } from '@/lib/db/postgres';
import { getCronStateStrict, setCronState } from '@/lib/db/cron-state';
import { logger } from '@/lib/utils/logger';
import { PAPER_TARGET_MAX_HOLD_MIN } from './config';

const MARKED_BOOKS = [-3, -4, -5, -7, -8];
/** Books with a stop and a time limit. The others close at a horizon or by a rule. */
const STRATEGY_BOOKS = new Set([-3, -4]);
const KEY_OVERDUE = 'paper-open-marks:overdue';
/** Ticks a position may stay past its exit before the warning: a book closes it on its next tick. */
const OVERDUE_TICKS = 2;
/** Slack past the time limit, so a position closing on schedule is never reported. */
const HOLD_SLACK_MIN = 60;

interface OpenRow {
  order_id: string;
  portfolio_id: number;
  asset: string;
  side: string;
  entry_price: string;
  notional_value: string;
  stop_loss: string | null;
  created_at: Date;
}

export interface OpenMark {
  orderId: string;
  portfolioId: number;
  markBp: number;
  markUsd: number;
  /** Why the position is past its exit, or null. */
  overdue: string | null;
}

/** Pure: a position's mark and whether it is past its exit. */
export function markOpenRow(row: OpenRow, mark: number, nowMs: number): OpenMark {
  const entry = Number(row.entry_price);
  const long = row.side.toUpperCase() === 'LONG';
  const markBp = ((long ? mark / entry : entry / mark) - 1) * 10_000;
  const markUsd = (markBp / 10_000) * Number(row.notional_value);
  let overdue: string | null = null;
  if (STRATEGY_BOOKS.has(row.portfolio_id)) {
    const stop = row.stop_loss === null ? NaN : Number(row.stop_loss);
    const ageMin = (nowMs - row.created_at.getTime()) / 60_000;
    if (stop > 0 && (long ? mark < stop : mark > stop)) overdue = `past its stop (${markBp.toFixed(0)} bp)`;
    else if (ageMin > PAPER_TARGET_MAX_HOLD_MIN + HOLD_SLACK_MIN) overdue = `open ${(ageMin / 60).toFixed(1)} h, past its time limit`;
  }
  return { orderId: row.order_id, portfolioId: row.portfolio_id, markBp, markUsd, overdue };
}

export async function markOpenPaperPositions(
  priceOf: (asset: string) => Promise<number>,
  nowMs: number = Date.now(),
): Promise<{ marked: number; overdue: string[] }> {
  const rows = await query<OpenRow>(
    `SELECT order_id, portfolio_id, asset, side, entry_price, notional_value, stop_loss, created_at
       FROM hedges WHERE status = 'active' AND portfolio_id = ANY($1::int[])`,
    [MARKED_BOOKS],
  );
  const prices = new Map<string, number>();
  for (const asset of new Set(rows.map((r) => r.asset))) {
    try {
      const p = await priceOf(asset);
      if (p > 0) prices.set(asset, p);
    } catch (e) {
      logger.warn('[open-marks] no price; rows keep their last mark', { asset, error: e instanceof Error ? e.message : String(e) });
    }
  }

  const before = (await getCronStateStrict<Record<string, number>>(KEY_OVERDUE)) ?? {};
  const counts: Record<string, number> = {};
  const overdue: string[] = [];
  let marked = 0;
  for (const row of rows) {
    const price = prices.get(row.asset);
    if (!price) continue;
    const m = markOpenRow(row, price, nowMs);
    await query(
      `UPDATE hedges SET current_price = $1, current_pnl = $2, price_updated_at = CURRENT_TIMESTAMP
        WHERE order_id = $3 AND status = 'active'`,
      [price, m.markUsd, m.orderId],
    );
    marked += 1;
    if (!m.overdue) continue;
    counts[m.orderId] = (before[m.orderId] ?? 0) + 1;
    if (counts[m.orderId] === OVERDUE_TICKS + 1) overdue.push(`book ${m.portfolioId} ${row.asset} ${row.side} ${m.orderId}: ${m.overdue}`);
  }
  // Rebuilt every tick: a position that closed or came back inside its exit drops out.
  await setCronState(KEY_OVERDUE, counts);

  if (overdue.length > 0) {
    const { notifyPaper } = await import('./notifications');
    await notifyPaper(
      `Paper position(s) held past their exit for ${OVERDUE_TICKS + 1} ticks: the book is not managing them.\n${overdue.join('\n')}`,
      'WARN',
      { overdue: overdue.length },
    );
  }
  return { marked, overdue };
}
