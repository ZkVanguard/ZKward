/**
 * OracleTrader — paper book that trades the AI Signal Interpreter at its
 * NATIVE horizon (portfolio -5).
 *
 * Why this exists (2026-09-28): the interpreter resolves 74-83% accurate
 * on its own daily/monthly threshold questions, but the ledger measured
 * the same signal at 5-22% when mechanically translated to 30-240min
 * trade windows — a horizon category error, not a weak signal. The
 * counterfactual on stored (entry_price, exit_price) pairs: trading every
 * resolved interpretation directionally at 1x with 13bp fees = 73.9% WR,
 * +1.55%/trade net (n=46); threshold-within-8%-of-spot subset = 76.5%,
 * +1.72%/trade. This book turns that counterfactual into a live,
 * forward-measured POC.
 *
 * Design:
 *   • Opens on fresh `signal_interpretations` rows (source='model',
 *     UP/DOWN, priceable asset, entry anchor present, horizon_end
 *     30min..48h out). Everything qualifying is opened and tagged
 *     `uncertain` (threshold within ORACLE_UNCERTAIN_BAND of spot) so
 *     both slices stay measurable.
 *   • Fixed $1k stake at 1x — isolates signal quality from sizing games.
 *   • Closes at horizon_end via the same fast tick. close_reason
 *     'horizon-expiry'. No stops, no flips: the METHODOLOGY is
 *     "bet the oracle's answer, score it when the question resolves",
 *     mirroring exactly how the 74-83% was measured.
 *   • Same isolation rules as the other paper books: own portfolio id,
 *     own cron_state keys, simulationMode rows, never touches treasury.
 */

import { createHash } from 'node:crypto';
import { query } from '@/lib/db/postgres';
import { getCronState, setCronState } from '@/lib/db/cron-state';
import { createHedge } from '@/lib/db/hedges';
import { logger } from '@/lib/utils/logger';
import { errMsg } from '@/lib/utils/error-handler';
import {
  simulateOpen,
  simulateClose,
  type SimulatedPosition,
  type Side,
} from './simulated-executor';

export const ORACLE_PORTFOLIO_ID = -5;
const CHAIN = 'hedera-testnet';

const STAKE_USD = Number(process.env.ORACLE_TRADER_STAKE_USD || 1_000);
const LEVERAGE = 1;
const MAX_OPENS_PER_TICK = Number(process.env.ORACLE_TRADER_MAX_OPENS_PER_TICK || 3);
const MIN_HORIZON_MS = Number(process.env.ORACLE_TRADER_MIN_HORIZON_MIN || 30) * 60_000;
const MAX_HORIZON_MS = Number(process.env.ORACLE_TRADER_MAX_HORIZON_H || 48) * 3_600_000;
const UNCERTAIN_BAND = Number(process.env.ORACLE_TRADER_UNCERTAIN_BAND || 0.08);
const DISABLED = /^(1|true|yes|on)$/i.test((process.env.ORACLE_TRADER_DISABLE || '').trim());

const KEY_POSITIONS = 'oracle-trader:active-positions';
const KEY_WATERMARK = 'oracle-trader:interp-watermark';
const KEY_STATS = 'oracle-trader:stats';

interface OraclePosition {
  orderId: string;
  slug: string;
  position: SimulatedPosition;
  closeAtMs: number;
  uncertain: boolean;
}

interface OracleStats {
  trades: number;
  wins: number;
  cumRealizedUsd: number;
}

export interface InterpRow {
  slug: string;
  asset: string | null;
  direction: string | null;
  threshold: number | null;
  entry_price_usd: number | null;
  horizon_end: string | Date | null;
  interpreted_at: string | Date;
}

/** Assets the multi-source price provider can anchor and resolve. */
const PRICEABLE = new Set(['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'SUI', 'ATOM']);

/**
 * Pure candidate filter — exported for tests.
 * A row qualifies when it is directional, priceable, carries an entry
 * anchor, and its horizon_end lands inside [now+MIN, now+MAX].
 */
export function selectOracleCandidates(
  rows: InterpRow[],
  now: number,
  limit: number = MAX_OPENS_PER_TICK,
): Array<{ row: InterpRow; side: Side; closeAtMs: number; uncertain: boolean }> {
  const out: Array<{ row: InterpRow; side: Side; closeAtMs: number; uncertain: boolean }> = [];
  for (const row of rows) {
    if (out.length >= limit) break;
    const side: Side | null =
      row.direction === 'UP' ? 'LONG' : row.direction === 'DOWN' ? 'SHORT' : null;
    if (!side) continue;
    const asset = (row.asset || '').toUpperCase();
    if (!PRICEABLE.has(asset)) continue;
    const entry = Number(row.entry_price_usd);
    if (!Number.isFinite(entry) || entry <= 0) continue;
    const horizonEnd = row.horizon_end ? new Date(row.horizon_end).getTime() : NaN;
    if (!Number.isFinite(horizonEnd)) continue;
    if (horizonEnd < now + MIN_HORIZON_MS || horizonEnd > now + MAX_HORIZON_MS) continue;
    const threshold = Number(row.threshold);
    const uncertain =
      Number.isFinite(threshold) && threshold > 0
        ? Math.abs(threshold - entry) / entry < UNCERTAIN_BAND
        : false;
    out.push({ row, side, closeAtMs: horizonEnd, uncertain });
  }
  return out;
}

export interface OracleTickSummary {
  opened: number;
  closed: number;
  active: number;
}

export class OracleTrader {
  static async runTick(now: number = Date.now()): Promise<OracleTickSummary> {
    const summary: OracleTickSummary = { opened: 0, closed: 0, active: 0 };
    if (DISABLED) return summary;

    let positions = ((await getCronState<OraclePosition[]>(KEY_POSITIONS)) ?? []).filter(Boolean);

    // ── Close phase: horizon_end reached → close at validated mark ──
    const due = positions.filter((p) => now >= p.closeAtMs);
    if (due.length > 0) {
      const { getMultiSourceValidatedPrice } = await import(
        '@/lib/services/market-data/unified-price-provider'
      );
      for (const pos of due) {
        try {
          const v = await getMultiSourceValidatedPrice(pos.position.asset, {
            minSources: 2,
            maxDeviationPercent: 2,
            timeout: 8000,
          });
          if (!v.price || v.price <= 0) continue; // retry next tick
          const result = simulateClose(pos.position, v.price, now);
          await query(
            `UPDATE hedges
             SET status = 'closed', realized_pnl = $1, current_pnl = $1,
                 funding_paid = $2, closed_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP, close_reason = 'horizon-expiry',
                 metadata = COALESCE(metadata, '{}'::jsonb) || $4::jsonb
             WHERE order_id = $3`,
            [
              result.realizedPnlUsd,
              result.fundingUsd,
              pos.orderId,
              JSON.stringify({ uncertain: pos.uncertain, slug: pos.slug }),
            ],
          );
          const stats = (await getCronState<OracleStats>(KEY_STATS)) ?? {
            trades: 0,
            wins: 0,
            cumRealizedUsd: 0,
          };
          stats.trades += 1;
          if (result.realizedPnlUsd > 0) stats.wins += 1;
          stats.cumRealizedUsd += result.realizedPnlUsd;
          await setCronState(KEY_STATS, stats);
          positions = positions.filter((p) => p.orderId !== pos.orderId);
          summary.closed += 1;
          logger.info('[OracleTrader] closed at horizon', {
            orderId: pos.orderId,
            realizedUsd: result.realizedPnlUsd.toFixed(2),
            wr: stats.trades > 0 ? (stats.wins / stats.trades).toFixed(3) : 'n/a',
          });
        } catch (e) {
          logger.warn('[OracleTrader] close failed (retry next tick)', {
            orderId: pos.orderId,
            error: errMsg(e),
          });
        }
      }
      await setCronState(KEY_POSITIONS, positions);
    }

    // ── Open phase: fresh model interpretations since the watermark ──
    try {
      const watermark = (await getCronState<string>(KEY_WATERMARK)) ?? '2026-09-28T00:00:00Z';
      const rows = await query<InterpRow>(
        `SELECT slug, asset, direction, threshold::float, entry_price_usd::float,
                horizon_end, interpreted_at
         FROM signal_interpretations
         WHERE source = 'model' AND interpreted_at > $1
         ORDER BY interpreted_at ASC
         LIMIT 25`,
        [watermark],
      );
      if (rows.length > 0) {
        // Watermark advances over EVERYTHING scanned (not just opened):
        // rows that fail the filter are permanently out of scope, which
        // keeps the scan O(new rows) forever.
        await setCronState(KEY_WATERMARK, new Date(
          Math.max(...rows.map((r) => new Date(r.interpreted_at).getTime())),
        ).toISOString());

        const held = new Set(positions.map((p) => p.slug));
        const candidates = selectOracleCandidates(
          rows.filter((r) => !held.has(r.slug)),
          now,
        );
        for (const cand of candidates) {
          const asset = (cand.row.asset || '').toUpperCase();
          const entryPrice = Number(cand.row.entry_price_usd);
          const position = simulateOpen(
            {
              asset,
              side: cand.side,
              notionalUsd: STAKE_USD * LEVERAGE,
              leverage: LEVERAGE,
              entryPrice,
            },
            now,
          );
          const slugHash = createHash('sha256').update(cand.row.slug).digest('hex').slice(0, 10);
          const orderId = `oracle_${slugHash}_${Math.floor(now / 1000)}`;
          try {
            await createHedge({
              orderId,
              portfolioId: ORACLE_PORTFOLIO_ID,
              asset,
              market: `${asset}-PERP`,
              side: cand.side,
              size: position.size,
              notionalValue: position.notionalUsd,
              leverage: LEVERAGE,
              entryPrice,
              simulationMode: true,
              reason: `oracle: ${cand.row.slug.slice(0, 60)} | uncertain=${cand.uncertain}`,
              predictionMarket: 'signal-interpreter',
              chain: CHAIN,
            });
            positions.push({
              orderId,
              slug: cand.row.slug,
              position,
              closeAtMs: cand.closeAtMs,
              uncertain: cand.uncertain,
            });
            summary.opened += 1;
            logger.info('[OracleTrader] opened at native horizon', {
              orderId,
              asset,
              side: cand.side,
              closeAt: new Date(cand.closeAtMs).toISOString(),
              uncertain: cand.uncertain,
            });
          } catch (e) {
            logger.warn('[OracleTrader] open failed (skipped)', {
              slug: cand.row.slug,
              error: errMsg(e),
            });
          }
        }
        if (summary.opened > 0) await setCronState(KEY_POSITIONS, positions);
      }
    } catch (e) {
      logger.warn('[OracleTrader] open phase failed (non-fatal)', { error: errMsg(e) });
    }

    summary.active = positions.length;
    return summary;
  }
}
