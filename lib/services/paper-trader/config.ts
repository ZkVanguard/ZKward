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
// Reduced again 2026-09-20 from 0.05 -> 0.02 for RESEARCH MODE (paired
// with loosened entry gates below). More trades × smaller size = more
// data with the same risk budget. Bump back to 0.05 or higher when the
// mainnet-readiness gates in docs/PAPER_TO_MAINNET_READINESS.md go green.
export const PAPER_STAKE_PCT = Number(process.env.PAPER_TRADER_STAKE_PCT || 0.02);

// ── Entry thresholds ────────────────────────────────────────────────
// Bumped 2026-09-22 (55 → 62 conf, 50 → 60 cons, 2 → 3 sources) as
// part of the "50%+ win rate" push. Root cause analysis showed median
// source hit rate is ~50-53%, so aggregating a marginal-conf signal
// converges to ~50% predictor. Tighter gates trade N-per-hour for
// per-trade edge; expected to lift win rate 5-10pct with same source
// pool. Env-tunable if further tuning proves productive.
//
// Fix J (2026-09-25): raised 62 → 70 after confidence-bucket audit.
// Historical win rates by opening confidence:
//   60-64 conf: 23.2% (n=56) ← WORST
//   65-69 conf: 32.1% (n=106)
//   70-74 conf: 38.4% (n=125) ← best
//   75-79 conf: 33.9% (n=56)
//   80-84 conf: 23.8% (n=21) ← higher confidence = worse
// Cuts the two worst buckets. Trade frequency roughly halves; expected
// win-rate lift ~5-8pp from removing the 62-69 tail.
export const PAPER_MIN_CONFIDENCE = Number(process.env.PAPER_TRADER_MIN_CONFIDENCE || 70);
export const PAPER_MIN_CONSENSUS = Number(process.env.PAPER_TRADER_MIN_CONSENSUS || 60);
export const PAPER_MIN_SOURCES = Number(process.env.PAPER_TRADER_MIN_SOURCES || 3);

// ── Hold windows ────────────────────────────────────────────────────
// Bumped 2026-09-20 from 20 → 45 min. Post-mortem on 164 paper trades
// (Bakchodi hedges 2026-09-15 to 09-19): the 20-25m near-timeout bucket
// held 72 trades / -$37.6K at 16.7% win rate — the timer was chopping
// positions right at their max drawdown. Trades that survived past the
// timer had markedly better outcomes: 25-45m bucket 46.7% win rate,
// 45m+ bucket 41.7%. Base ceiling shifted so moves get time to develop.
// Kill switch: set PAPER_TRADER_MAX_HOLD_MIN=20 in env to revert.
export const PAPER_MAX_HOLD_MIN = Number(process.env.PAPER_TRADER_MAX_HOLD_MIN || 45);
// Signal-strength-scaled hold ceiling: strong signals earn more time so
// moves develop past the 13bp fee floor. Weak signals stay at the base.
// At scalar=0.4 (min gate 55/50): +0min  → 45 min hold.
// At scalar=1.0 (strong 80/75):   +36min → 81 min hold.
// At scalar=2.0 (95/95):          +90min → 135 min hold.
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

// Fix G (2026-09-25) — short-window rolling-loss halt.
// The existing consecutive-loss halt resets on any interspersed win,
// so a chop regime that lands one $10 win between 8 losers won't fire
// it. This tracks losses in a rolling minutes-window (default 90m) and
// halts when EITHER loss count OR cumulative loss magnitude crosses a
// threshold. Complements the 7d rolling-DD halt (too slow to catch a
// same-day regime break) and the daily profit-lock (needs a NAV drop
// meaningful vs the whole book).
export const PAPER_ROLLING_LOSS_WINDOW_MIN = Number(
  process.env.PAPER_TRADER_ROLLING_LOSS_WINDOW_MIN || 90,
);
export const PAPER_ROLLING_LOSS_COUNT_TRIP = Number(
  process.env.PAPER_TRADER_ROLLING_LOSS_COUNT_TRIP || 5,
);
export const PAPER_ROLLING_LOSS_USD_TRIP = Number(
  process.env.PAPER_TRADER_ROLLING_LOSS_USD_TRIP || 500,
);
export const PAPER_ROLLING_LOSS_HALT_HOURS = Number(
  process.env.PAPER_TRADER_ROLLING_LOSS_HALT_HOURS || 4,
);

// Fix K (2026-09-26) — calibrated-probability-driven ranking + gating.
//
// The probability-calibrator learns per-(asset, side, conf-bucket) actual
// win rate. Historically the paper trader USED it only as a binary
// gate ("skip if calibrated < 50%"), and RANKED candidates by raw
// aggregator score. But raw score is broken — bucket 80-84 was 23.8% wr,
// bucket 70-74 was 38.4% wr (data 2026-09-25). Ranking by raw meant
// picking high-conf/low-win-rate signals over low-conf/high-win-rate.
//
// This bumps the gate to a fee-adjusted breakeven and switches ranking
// to calibrated probability when enough data exists.
//
// Threshold math: 3× leverage, 13bp round-trip fees, ~55/45 avg win/loss
// dollar asymmetry → breakeven around 53% win rate. Everything below
// bleeds after fees.
export const PAPER_CALIBRATED_MIN_WIN_RATE = Number(
  process.env.PAPER_TRADER_CALIBRATED_MIN_WIN_RATE || 0.53,
);
// Min bucket samples before calibrated prob replaces raw score as rank
// key AND before the 53% gate fires. Shrinkage vs coverage tradeoff at
// PRIOR_STRENGTH=10: n=5 → raw contributes 67% weight (gate toothless),
// n=20 → raw 33% (catches worst buckets), n=50 → raw 17% (ideal but few
// buckets meet it). Bumped 5 → 20 on 2026-09-26 after audit showed a
// 40%-actual-wr bucket at conf=70 was calibrating to 0.60 and passing
// the 53% gate. Push to 50 once lifetime trades > 1000.
export const PAPER_CALIBRATED_RANK_MIN_N = Number(
  process.env.PAPER_TRADER_CALIBRATED_RANK_MIN_N || 20,
);

// Fix L (2026-09-26) — asset-side hard blacklist based on lifetime
// empirical hit rate. Deep-dive audit showed 5 of 9 (asset,side) pairs
// bleed 97% of the total loss:
//   BTC LONG  114 tr / 26% wr / -$24k  ← 34% of bleed
//   ETH SHORT  70 tr / 33% wr / -$20k
//   SOL LONG   32 tr / 34% wr / -$14k
//   BTC SHORT  36 tr / 22% wr / -$11k
//   SOL SHORT  15 tr / 27% wr /  -$3k
// The 3 winners (XRP LONG/SHORT, DOGE SHORT) net +$2k. Fix L blocks
// any (asset,side) whose lifetime win rate is below MIN_WR AND has
// at least MIN_N closed trades of evidence. Cold pairs pass through.
//
// Complements Fix K (calibrator per-bucket) — Fix L is a BROADER
// per-pair filter that catches asset-sides where every conf bucket
// bleeds. Cache the pair list for 30 min so we don't hit the DB
// every candidate.
export const PAPER_ASSET_SIDE_BLACKLIST_MIN_WR = Number(
  process.env.PAPER_TRADER_ASSET_SIDE_BLACKLIST_MIN_WR || 0.40,
);
export const PAPER_ASSET_SIDE_BLACKLIST_MIN_N = Number(
  process.env.PAPER_TRADER_ASSET_SIDE_BLACKLIST_MIN_N || 20,
);
export const PAPER_ASSET_SIDE_BLACKLIST_CACHE_TTL_MS = Number(
  process.env.PAPER_TRADER_ASSET_SIDE_BLACKLIST_CACHE_TTL_MS || 30 * 60_000,
);

/**
 * Max stake per trade as a fraction of NAV, applied AFTER all sizing
 * multipliers (signalScalar × volMult × calibrationBoost).
 *
 * Was missing until 2026-09-22. Live Polymarket-edge-trader has a
 * $500 hard cap (POLYMARKET_EDGE_MAX_STAKE_USD); paper had no
 * equivalent. On $670K NAV with all boosts maxed, effective stake
 * could hit $60K (~9% of NAV) × 3× leverage = $180K notional per
 * trade × 3 concurrent = 80% of NAV levered 3×. That's unbounded
 * risk that distorts win rates and PnL variance vs any realistic
 * mainnet deployment.
 *
 * Cut 5% → 3% (2026-09-22) after observed max-hold + stop-loss trades
 * generated -$40 to -$62 per hit at 5%. Halving stake halves per-trade
 * dollar loss magnitude while keeping the strategy exposure similar to
 * a live $10K vault at ~3% stake ($300/trade).
 *
 * Fix N (2026-09-26): 3% → 1.5%. Deep-dive audit showed fee cost is
 * $117/trade avg on 379 lifetime trades = $44k of the $71k total bleed.
 * Halving stake halves fee cost too. With 33% win rate + 1.4× loss/win
 * ratio, we need 55% wr to overcome $117/trade fees. Trade smaller
 * until Fix L (asset-side blacklist) + Fix K (calibrator ranking)
 * lift the win rate to fee-breakeven.
 */
export const PAPER_MAX_STAKE_PCT = Number(
  process.env.PAPER_TRADER_MAX_STAKE_PCT || 0.015,
);

/**
 * Global halt bypass for pure data-gathering mode.
 *
 * When set (=1|true|yes|on) the paper trader skips ALL safety halts:
 *   • rolling-drawdown 7d-vs-7d kill switch
 *   • existing haltedUntilMs cool-down
 *   • profit-lock daily-drawdown halt
 *   • consecutive-losses streak halt
 *
 * Intent: unblock continuous data collection across every regime and
 * failure mode so we see how the strategy behaves without safeties
 * gating it. Paper only — real trader's kill switches are separate.
 * Default OFF so safety-first behavior is preserved unless opted out.
 */
export const PAPER_DISABLE_HALTS = /^(1|true|yes|on)$/i.test(
  (process.env.PAPER_TRADER_DISABLE_HALTS || '').trim(),
);

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

// ── Discord digest mode ────────────────────────────────────────────
// When enabled, TRADE-level OPEN/CLOSE events are buffered and flushed
// as one summary Discord message on cadence. Halts, price failures, and
// other WARN/KILL levels still fire immediately regardless. Opt-in —
// default OFF preserves current per-trade behavior.
export const PAPER_DISCORD_DIGEST_ENABLED =
  (process.env.PAPER_TRADER_DISCORD_DIGEST || '').trim() === '1';
export const PAPER_DIGEST_FLUSH_MS = Number(
  process.env.PAPER_TRADER_DIGEST_FLUSH_MS || 60 * 60 * 1000,
);
export const PAPER_DIGEST_FLUSH_MAX_EVENTS = Number(
  process.env.PAPER_TRADER_DIGEST_FLUSH_MAX_EVENTS || 20,
);
export const KEY_DIGEST_BUFFER = 'paper-trader:discord-digest';

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
export const KEY_LAST_SKIP = 'paper-trader:last-skip';
// Concurrent-mode array of active positions. Only used when
// PAPER_MAX_CONCURRENT > 1. Single-position mode continues to use
// KEY_POSITION + KEY_ORDER_ID untouched. Migration is automatic on
// first tick after concurrent mode enables.
export const KEY_POSITIONS = 'paper-trader:active-positions';

export const NAV_SERIES_MAX = 500;

// ── Concurrent positions ────────────────────────────────────────────
// Default 1 = legacy single-position mode. Bump to open positions on
// multiple assets simultaneously. Cap enforced at handleEntry — once
// N positions are active, new opens skip until one closes.
// RESEARCH MODE (2026-09-20): 1 → 3 to parallelize entries across
// assets and burn through more sample trades per hour. Correlation
// cluster cap (PAPER_MAX_SAME_DIR_PER_CLUSTER) still holds so BTC/
// ETH/SOL can't all be same-side long at once.
export const PAPER_MAX_CONCURRENT = Math.max(
  1,
  Number(process.env.PAPER_TRADER_MAX_CONCURRENT || 3),
);

/**
 * Correlation clusters — assets that move together enough that opening
 * same-direction positions across the cluster is one bet, not N.
 * When PAPER_MAX_SAME_DIR_PER_CLUSTER is enforced, handleEntry refuses
 * a new position if it would exceed the cap in a cluster the new asset
 * belongs to. Default: BTC / ETH / SOL are one cluster (empirical
 * 0.85+ 5-min correlation on 2026 crypto perp data).
 */
export const PAPER_CORRELATION_CLUSTERS: Array<string[]> = (() => {
  const raw = process.env.PAPER_TRADER_CORRELATION_CLUSTERS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as string[][];
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // fall through
    }
  }
  return [['BTC', 'ETH', 'SOL']];
})();
export const PAPER_MAX_SAME_DIR_PER_CLUSTER = Math.max(
  1,
  Number(process.env.PAPER_TRADER_MAX_SAME_DIR_PER_CLUSTER || 2),
);

// ── Signal-quality filters (2026-09-18) ────────────────────────────
//
// Root cause of 22% win rate: the aggregator produces directional
// recommendations that contradict the majority of underlying sources.
// Observed on ETH: aggregate=HEDGE_LONG while 4 of 7 sources said
// DOWN — weighted math let a couple of high-confidence-low-weight
// sources dominate.
//
// Two filters gate opens on top of the aggregate:
//   1. Majority agreement: reject if fewer than N% of sources point
//      the same direction as the aggregate.
//   2. Stability: require the aggregate to hold the same direction
//      across the last K ticks. Kills the flip-flop pattern where
//      opens close via signal-flip within 9 min of entry.
// RESEARCH MODE (2026-09-20): loosened from 0.60 to 0.55 to un-block
// the trader after a 20-hour idle stretch where every candidate was
// getting rejected at exactly 50% source agreement. Cost: slightly
// noisier entries. Mitigation: PAPER_STAKE_PCT halved to 0.02 above,
// and the price-anchored stop-loss + 45m max-hold shipped 2026-09-20
// bound per-trade damage. Tighten back to 0.6+ once the mainnet-
// readiness gates in docs/PAPER_TO_MAINNET_READINESS.md go green.
export const PAPER_MIN_MAJORITY_PCT = Number(
  process.env.PAPER_TRADER_MIN_MAJORITY_PCT || 0.55,
);
// Bumped 1 → 2 on 2026-09-26. Trade-log audit showed BTC/ETH/SOL signal
// flipping in 4-15 min at 3× leverage — max-hold does NOT catch chop
// that flips inside 45m. Require the same direction for 2 consecutive
// ticks (10 min) before entry. Cost: ~5 min more time-to-first-trade
// after a fresh signal appears.
export const PAPER_MIN_STABLE_TICKS = Math.max(
  1,
  Number(process.env.PAPER_TRADER_MIN_STABLE_TICKS || 2),
);
export const KEY_SIGNAL_HISTORY = 'paper-trader:signal-history';

/**
 * Signal-flip anti-whipsaw gates (2026-09-22).
 *
 * Diagnosed: BTC LONG closed at -$35/-$38/-$39 within 15 min of open,
 * all via 'signal flipped'. Cause: the flip-close path had ZERO
 * stability or hold-time checks — any opposite signal >= 55% conf
 * closed the position instantly. Fees + micro-adverse move ate the
 * position on every flip. Entry has majority+stability filters; exit
 * did not (asymmetric).
 *
 * Two symmetric gates now guard the flip-close path:
 *   • MIN_FLIP_AGE_SEC — position must be at least this old before
 *     any flip-close is even considered. Sub-3-min positions ride
 *     out the tick regardless of signal noise.
 *   • MIN_FLIP_CONFIDENCE — the opposite signal must clear a HIGHER
 *     confidence bar than the entry gate (65 vs 55) to justify the
 *     round-trip cost.
 */
// Fix M (2026-09-26): raised 180 → 900. Signal-flip whipsaw audit
// (2026-09-26) showed flips closed under 15 min win 12-27% and lose money;
// flips at 30+ min age win 68% and net positive. The 3-min gate let the
// whipsaw class through.
export const PAPER_MIN_FLIP_AGE_SEC = Number(
  process.env.PAPER_TRADER_MIN_FLIP_AGE_SEC || 900,
);
export const PAPER_MIN_FLIP_CONFIDENCE = Number(
  process.env.PAPER_TRADER_MIN_FLIP_CONFIDENCE || 65,
);

// ── Skip STRONG_ signals (2026-09-18) ──────────────────────────────
// Mirrors POLYMARKET_EDGE_SKIP_STRONG_SIGNALS on the live trader.
// Historical outcome analysis (2026-08-28, live-trader data):
//   HEDGE_LONG (moderate):    3 trades, 100% win, +$0.07 PnL
//   STRONG_HEDGE_LONG:       16 trades,  13% win, -$0.34 PnL
// The "STRONG_" upgrade fires when Polymarket consensus is already
// high, which usually means the move is priced in and mean-reversion
// follows. Live trader has skipped these by default for weeks; paper
// should too. Opt-out via PAPER_TRADER_SKIP_STRONG_SIGNALS=0.
export const PAPER_SKIP_STRONG_SIGNALS =
  (process.env.PAPER_TRADER_SKIP_STRONG_SIGNALS || '1').trim() !== '0';
