/**
 * Paper trader — env-tunable config + core reference data.
 *
 * Extracted from PaperTrader.ts to make the trader file focus on
 * orchestration logic rather than tuning knobs. Every constant here
 * is env-overridable so operators can tune without redeploying.
 */

// ── Universe + capital ──────────────────────────────────────────────
export const PAPER_UNIVERSE = (process.env.PAPER_TRADER_ASSETS || 'BTC,ETH,SOL,XRP,DOGE')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

export const PAPER_STARTING_NAV = Number(process.env.PAPER_TRADER_STARTING_NAV || 100_000);
export const PAPER_LEVERAGE = Number(process.env.PAPER_TRADER_LEVERAGE || 3);

// ── Sizing ──────────────────────────────────────────────────────────
// Reduced 2026-09-17 from 0.20 -> 0.05. At 20% stake × 3x leverage every
// trade risked 60% of NAV in gross notional. Observed 118 trades, 25%
// win rate, -$62.5k in 2.4 days on a $607k NAV — sizing did the damage,
// not signal quality.
export const PAPER_STAKE_PCT = Number(process.env.PAPER_TRADER_STAKE_PCT || 0.05);

// ── Entry thresholds ────────────────────────────────────────────────
export const PAPER_MIN_CONFIDENCE = Number(process.env.PAPER_TRADER_MIN_CONFIDENCE || 55);
export const PAPER_MIN_CONSENSUS = Number(process.env.PAPER_TRADER_MIN_CONSENSUS || 50);
export const PAPER_MIN_SOURCES = Number(process.env.PAPER_TRADER_MIN_SOURCES || 2);

// ── Hold windows ────────────────────────────────────────────────────
export const PAPER_MAX_HOLD_MIN = Number(process.env.PAPER_TRADER_MAX_HOLD_MIN || 20);
// Signal-strength-scaled hold ceiling: strong signals earn more time so
// moves develop past the 13bp fee floor. Weak signals stay at the base.
// At scalar=0.4 (min gate 55/50): +0min → 20 min hold.
// At scalar=1.0 (strong 80/75):    +36min → 56 min hold.
// At scalar=2.0 (95/95):           +90min → 110 min hold.
export const PAPER_MAX_HOLD_EXTRA_MIN = Number(
  process.env.PAPER_TRADER_MAX_HOLD_EXTRA_MIN || 90,
);

// ── Risk-control gates ──────────────────────────────────────────────
export const PAPER_PROFIT_LOCK_DRAWDOWN_PCT = Number(
  process.env.PAPER_TRADER_PROFIT_LOCK_DRAWDOWN || 0.05,
);
export const PAPER_STOP_LOSS_PCT = Number(process.env.PAPER_TRADER_STOP_LOSS_PCT || 0.02);
export const PAPER_MAX_CONSECUTIVE_LOSSES = Number(
  process.env.PAPER_TRADER_MAX_CONSECUTIVE_LOSSES || 5,
);
export const PAPER_HALT_HOURS = Number(process.env.PAPER_TRADER_HALT_HOURS || 4);

// ── Trailing stop ───────────────────────────────────────────────────
export const PAPER_TRAILING_STOP_ARM_PCT = Number(
  process.env.PAPER_TRADER_TRAILING_ARM_PCT || 0.01,
);
export const PAPER_TRAILING_STOP_GIVEBACK_PCT = Number(
  process.env.PAPER_TRADER_TRAILING_GIVEBACK_PCT || 0.5,
);

// ── Regret cooldown ─────────────────────────────────────────────────
export const PAPER_REGRET_COOLDOWN_PCT = Number(
  process.env.PAPER_TRADER_REGRET_COOLDOWN_PCT || 0.02,
);
export const PAPER_REGRET_WINDOW = Number(process.env.PAPER_TRADER_REGRET_WINDOW || 20);

/**
 * Per-asset volatility multiplier — the "vol parity" fix. SOL and small-caps
 * are ~2x more volatile than BTC; equal notional means unequal risk. This
 * scales stake DOWN for high-vol assets so the max-loss floor lines up.
 * Override with PAPER_TRADER_ASSET_VOL_MULT='{"BTC":1,"ETH":0.9,...}'.
 */
export const PAPER_ASSET_VOL_MULT: Record<string, number> = (() => {
  const raw = process.env.PAPER_TRADER_ASSET_VOL_MULT;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, number>;
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // Fall through to default.
    }
  }
  return { BTC: 1.0, ETH: 0.85, SOL: 0.55, XRP: 0.65, DOGE: 0.50 };
})();

// ── Fixed keys + IDs ────────────────────────────────────────────────
export const PAPER_PORTFOLIO_ID = -3;
export const PAPER_CHAIN = 'hedera-testnet';

export const KEY_POSITION = 'paper-trader:active-position';
export const KEY_ORDER_ID = 'paper-trader:active-order-id';
export const KEY_NAV = 'paper-trader:nav-usd';
export const KEY_STATS = 'paper-trader:stats';
export const KEY_NAV_SERIES = 'paper-trader:nav-series';
export const KEY_LAST_RUN = 'cron:lastRun:paper-trader';

export const NAV_SERIES_MAX = 500;
