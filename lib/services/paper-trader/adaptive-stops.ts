/**
 * L7 — Volatility-adaptive stop-loss and trailing-arm.
 *
 * A fixed 1.2% stop is wrong at both ends of the vol regime:
 *   • high vol (60%+ annualized) — 1.2% is inside typical intra-window
 *     noise; every trade gets stopped out before the signal plays out.
 *   • low vol (20-30%) — 1.2% is way outside the noise floor; a
 *     legitimate small loss is allowed to run to -1.2% when 0.5%
 *     would have cut it clean.
 *
 * Fix: express stop and trailing-arm in units of expected move over the
 * hold window (45 min, matching config's base max-hold).
 *
 *   expected_move_frac = annualized_vol / sqrt(windows_per_year)
 *
 * Stop-loss target = 2.0× expected move (survives typical mean-reversion
 * before the trend plays), trailing-arm = 1.5× (triggers only on genuinely
 * directional moves, not chop). Per-asset floor for micro-caps that
 * mean-revert wide (DOGE/XRP default 1.8%).
 *
 * Uses the existing Deribit / Binance vol reader from volatility-gate.
 * Falls back to the env-configured static value if vol fetch fails —
 * fail-open, don't halt the trader.
 */

import { logger } from '@/lib/utils/logger';
import { errMsg } from '@/lib/utils/error-handler';
import { getRealizedVolPct, getBinanceRealizedVolPct } from './volatility-gate';

// Static config from env, used as fallback when vol data is unavailable.
const STATIC_STOP_LOSS_PCT = Number(process.env.PAPER_TRADER_STOP_LOSS_PCT || 0.012);
const STATIC_TRAILING_ARM_PCT = Number(process.env.PAPER_TRADER_TRAILING_ARM_PCT || 0.006);

// Scale factors — how many "expected moves" the stop/arm should be.
// 2026-09-25 (Fix D): stop mult 1.2 → 2.0 and window 20 → 45 min. DOGE
// SHORT was picked off for -$528 by 1.2% noise inside its 45-min hold.
// 20-min expected-move × 1.2 underestimates the max adverse excursion
// a 45-min hold has to survive; 45-min window × 2.0 gives the position
// room to breathe through typical mean-reversion before the trend plays.
const STOP_MULTIPLE = Number(process.env.PAPER_TRADER_ADAPTIVE_STOP_MULT || 2.0);
const TRAILING_ARM_MULTIPLE = Number(process.env.PAPER_TRADER_ADAPTIVE_ARM_MULT || 1.5);

// Safety clamps — never let the adaptive stop go absurd in either direction.
// MIN raised 1.0% → 2.5% on 2026-09-26. Trade audit: SOL/XRP stopped
// out on 5-6bp move past 1.2-1.4% stops (adaptive × CHOP regime 0.75×
// scaling can pull below the intended floor). 2.5% survives typical
// 45-min mean reversion at 3× leverage without turning stops into
// silent no-ops. Env override: PAPER_TRADER_MIN_STOP_PCT.
const MIN_STOP_PCT = Number(process.env.PAPER_TRADER_MIN_STOP_PCT || 0.025);
const MAX_STOP_PCT = 0.05;  // 5% — anything wider is a stop-loss in name only
const MIN_ARM_PCT = 0.003;
const MAX_ARM_PCT = 0.04;

const HOLD_WINDOW_MIN = 45; // matches base max-hold in config.ts
const WINDOWS_PER_YEAR = (365 * 24 * 60) / HOLD_WINDOW_MIN;

// Per-asset stop floor overrides for micro-caps that mean-revert wide.
// DOGE @ 80-120% annual vol has intra-hour excursions that swallow a
// 1.2% stop; XRP behaves similarly. Env override:
// PAPER_ASSET_STOP_FLOOR_PCT_DOGE=0.02
function assetStopFloor(asset: string): number {
  const upper = asset.toUpperCase();
  const raw = process.env[`PAPER_ASSET_STOP_FLOOR_PCT_${upper}`];
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  // DOGE/XRP kept slightly wider than the base MIN — historically their
  // 45-min noise band is bigger than BTC/ETH. But never LOWER than the
  // base MIN (regime scaling could pull DOGE below the intended floor).
  if (upper === 'DOGE' || upper === 'XRP') return Math.max(MIN_STOP_PCT, 0.025);
  return MIN_STOP_PCT;
}

interface AdaptiveThresholds {
  stopLossPct: number;
  trailingArmPct: number;
  source: 'adaptive' | 'static-fallback';
}

async function annualVolFor(asset: string): Promise<number | null> {
  const upper = asset.toUpperCase();
  if (upper === 'BTC' || upper === 'ETH') {
    return getRealizedVolPct(upper);
  }
  return getBinanceRealizedVolPct(upper);
}

/**
 * Compute adaptive stop-loss + trailing-arm thresholds for an asset,
 * as fractions of NAV (matching the existing static config shape).
 *
 * Returns the STATIC config values on any error — fail-open. Callers
 * substitute in the returned percentages 1:1 with the old constants.
 */
export async function computeAdaptiveThresholds(asset: string): Promise<AdaptiveThresholds> {
  try {
    const annualPct = await annualVolFor(asset);
    let stopLossPct = STATIC_STOP_LOSS_PCT;
    let trailingArmPct = STATIC_TRAILING_ARM_PCT;
    let src: AdaptiveThresholds['source'] = 'static-fallback';

    const floor = assetStopFloor(asset);
    if (annualPct && annualPct > 0) {
      const annualFrac = annualPct / 100;
      const expectedMoveFrac = annualFrac / Math.sqrt(WINDOWS_PER_YEAR);
      stopLossPct = Math.max(
        floor,
        Math.min(MAX_STOP_PCT, expectedMoveFrac * STOP_MULTIPLE),
      );
      trailingArmPct = Math.max(
        MIN_ARM_PCT,
        Math.min(MAX_ARM_PCT, expectedMoveFrac * TRAILING_ARM_MULTIPLE),
      );
      src = 'adaptive';
    } else {
      stopLossPct = Math.max(floor, stopLossPct);
    }

    // L10 — apply the active regime's stop multiplier on top of the
    // vol-adaptive value. Chop → 0.75× stop, trending → 1.5× stop, so
    // winners get room to run in a trend but losers cut fast in chop.
    try {
      const { getCurrentRegime, getRegimeMultipliers } = await import('./regime');
      const { regime } = await getCurrentRegime();
      const mults = getRegimeMultipliers(regime);
      stopLossPct = Math.max(floor, Math.min(MAX_STOP_PCT, stopLossPct * mults.stopLossMult));
      // Trailing arm not regime-scaled — it's about winning-move detection,
      // regime primarily affects loss tolerance.
    } catch { /* regime lookup optional */ }

    return { stopLossPct, trailingArmPct, source: src };
  } catch (e) {
    logger.debug('[AdaptiveStops] compute failed (fail-open)', {
      asset, error: errMsg(e),
    });
    return {
      stopLossPct: Math.max(assetStopFloor(asset), STATIC_STOP_LOSS_PCT),
      trailingArmPct: STATIC_TRAILING_ARM_PCT,
      source: 'static-fallback',
    };
  }
}

// Test-only exports
export {
  STATIC_STOP_LOSS_PCT as _STATIC_STOP_LOSS_PCT,
  STATIC_TRAILING_ARM_PCT as _STATIC_TRAILING_ARM_PCT,
  STOP_MULTIPLE as _STOP_MULTIPLE,
  TRAILING_ARM_MULTIPLE as _TRAILING_ARM_MULTIPLE,
  HOLD_WINDOW_MIN as _HOLD_WINDOW_MIN,
};
