/**
 * Per-(asset, side) consecutive-loss + trend-alignment guards.
 *
 * Motivating incident 2026-09-19: 7 consecutive BTC LONG trades lost
 * -$651 total during a low-volatility grind ($81,020 → $81,317 range).
 * Signals correctly called UP, but 20-min holds of ~$100 moves couldn't
 * overcome the ~$105 fee floor on $87k notional. Existing regret
 * cooldown (20-trade rolling, -$12k threshold) was too slow.
 *
 * Two gates here run alongside the existing regret cooldown, catching
 * the streak pattern the rolling window misses.
 */
import { query } from '@/lib/db/postgres';
import { logger } from '@/lib/utils/logger';
import { errMsg } from '@/lib/utils/error-handler';
import { getMultiSourceValidatedPrice } from '@/lib/services/market-data/unified-price-provider';
import type { Side } from './simulated-executor';

/** Env-tunable — number of consecutive losses on (asset, side) that
 *  triggers a cooldown. Default 3 balances fast-catch vs statistical
 *  noise (a single unlucky streak of 3 is possible at 50% win rate but
 *  probability drops sharply beyond that). */
const STREAK_LOSS_COUNT = Number(process.env.PAPER_TRADER_STREAK_LOSS_COUNT || 3);

/** How long to pause the specific (asset, side) after tripping the
 *  streak. 4h is long enough to let a losing directional regime clear;
 *  short enough that a real trend reversal isn't missed. */
const STREAK_COOLDOWN_MS = Number(process.env.PAPER_TRADER_STREAK_COOLDOWN_HOURS || 4) * 60 * 60 * 1000;

/** Consecutive-loss check on (asset, side).
 *  Returns a rejection reason when the last N trades on this pair were
 *  ALL losses AND the most recent one was within COOLDOWN_MS.
 *
 *  Why "last N in a row" not "N of last 20": a streak is temporal.
 *  If the last 20 trades on BTC LONG mix wins and losses, the pair is
 *  probably fine. What we want to catch is the "regime just flipped
 *  against us" pattern.
 */
export async function assetSideStreakRejection(
  asset: string,
  side: Side,
  now: number,
): Promise<string | null> {
  try {
    // Pull the last STREAK_LOSS_COUNT closed trades on this (asset, side)
    // ordered by close time. If ALL are losses AND the most recent
    // closed less than COOLDOWN_MS ago, we're in the pause window.
    // Filter by portfolio_id so PaperGatedTrader (-4) losses don't
    // trigger cooldowns on PaperTrader (-3) — both share the paper_%
    // LIKE prefix (paper_ vs paper_gated_) causing cross-portfolio
    // contamination. Fixed 2026-09-22.
    const { PAPER_PORTFOLIO_ID } = await import('./config');
    const rows = await query<{
      realized_pnl: string | number | null;
      closed_at: Date;
    }>(
      `SELECT COALESCE(realized_pnl, 0) AS realized_pnl, closed_at
       FROM hedges
       WHERE portfolio_id = $4
         AND order_id LIKE 'paper_%'
         AND asset = $1 AND side = $2 AND status = 'closed'
       ORDER BY closed_at DESC NULLS LAST
       LIMIT $3`,
      [asset, side, STREAK_LOSS_COUNT, PAPER_PORTFOLIO_ID],
    );
    if (rows.length < STREAK_LOSS_COUNT) return null; // insufficient history
    const allLosses = rows.every((r) => Number(r.realized_pnl ?? 0) <= 0);
    if (!allLosses) return null;
    const mostRecentAt = new Date(rows[0].closed_at).getTime();
    const elapsed = now - mostRecentAt;
    if (elapsed >= STREAK_COOLDOWN_MS) return null; // cooldown expired
    const remainMin = Math.round((STREAK_COOLDOWN_MS - elapsed) / 60_000);
    return `streak-cooldown: ${STREAK_LOSS_COUNT} consecutive ${asset} ${side} losses — pause ${remainMin}min more`;
  } catch (e) {
    logger.debug('[PaperTrader] streak-guard lookup failed (non-fatal)', {
      asset, side, error: errMsg(e),
    });
    return null;
  }
}

/** Trend-alignment filter. Refuses trades that fight the recent price
 *  trend on this asset. Uses a simple 1h SMA proxy computed from the
 *  paper trader's own history (which stores entry_price + closed_at
 *  for the last N trades on this asset). No external candle API.
 *
 *  Why paper-history proxy: adding an external candles API is a whole
 *  new integration surface (rate limits, error handling, staleness).
 *  Our own trade history has entry prices at ~5-min intervals during
 *  active periods — enough resolution for a trend read.
 *
 *  Rule: if the last 6 entry prices on this asset show a monotonic
 *  down-move and the candidate is LONG, refuse (or vice versa for
 *  SHORT). Only fires when trend signal is clear.
 */
export async function trendMisalignmentRejection(
  asset: string,
  side: Side,
): Promise<string | null> {
  try {
    // Filter by portfolio_id to avoid PaperGatedTrader (-4) entries
    // polluting PaperTrader's (-3) trend proxy (see streak-guard fix).
    const { PAPER_PORTFOLIO_ID } = await import('./config');
    // Prefer multi-source live price + last N entry prices from paper history.
    const rows = await query<{
      entry_price: string | number | null;
      created_at: Date;
    }>(
      `SELECT entry_price, created_at
       FROM hedges
       WHERE portfolio_id = $2
         AND order_id LIKE 'paper_%'
         AND asset = $1 AND entry_price IS NOT NULL
       ORDER BY created_at DESC
       LIMIT 6`,
      [asset, PAPER_PORTFOLIO_ID],
    );
    if (rows.length < 4) return null; // not enough history to judge

    const nowValidated = await getMultiSourceValidatedPrice(asset).catch(() => ({ price: 0 }));
    const nowPrice = Number(nowValidated.price) || 0;
    if (nowPrice <= 0) return null; // no live price to compare against

    const oldestPrice = Number(rows[rows.length - 1].entry_price ?? 0);
    if (oldestPrice <= 0) return null;
    const changePct = (nowPrice - oldestPrice) / oldestPrice;

    // Trend threshold: 0.3% move over the last ~30-60 min window (6 recent
    // trades). Under this = flat/noise, don't apply trend filter.
    const TREND_THRESHOLD = 0.003;
    if (Math.abs(changePct) < TREND_THRESHOLD) return null;

    const trendUp = changePct > 0;
    // LONG when trend down = misalignment. SHORT when trend up = misalignment.
    if (side === 'LONG' && !trendUp) {
      return `trend-misalignment: ${asset} down ${(changePct * 100).toFixed(2)}% vs recent — LONG refused`;
    }
    if (side === 'SHORT' && trendUp) {
      return `trend-misalignment: ${asset} up ${(changePct * 100).toFixed(2)}% vs recent — SHORT refused`;
    }
    return null;
  } catch (e) {
    logger.debug('[PaperTrader] trend-guard lookup failed (non-fatal)', {
      asset, side, error: errMsg(e),
    });
    return null;
  }
}
