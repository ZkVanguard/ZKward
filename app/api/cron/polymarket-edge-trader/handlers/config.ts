/**
 * Env-driven config + cron_state keys for the polymarket-edge-trader.
 *
 * Extracted from route.ts on 2026-08-10. Keep all trader-side tunables
 * discoverable from ONE file so operators grepping for a knob don't have
 * to hunt across the split.
 */
import { CronKeys } from '@/lib/db/cron-state';
import { envFlagOnByDefault } from '@/lib/utils/env-flag';
import {
  DEFAULT_TRAILING_STOP_CONFIG,
} from '@/lib/services/trading/trailing-stop';

// ── Signal + risk thresholds ─────────────────────────────────────────────
// Defaults lowered 2026-06-22 from 60/60 → 55/50. Trader had been returning
// action='no-edge' every 5-min tick because BTC/ETH 5-min binaries rarely
// hit BOTH thresholds at 60 simultaneously in normal market regimes.
export const MIN_CONFIDENCE = Number(process.env.POLYMARKET_EDGE_MIN_CONFIDENCE || 55);
export const MIN_CONSENSUS = Number(process.env.POLYMARKET_EDGE_MIN_CONSENSUS || 50);
export const MIN_FREE_COLLATERAL_USD = Number(process.env.POLYMARKET_EDGE_MIN_COLLATERAL || 15);

// ── Stake sizing ─────────────────────────────────────────────────────────
// Base $5. Reverted 2026-07-14 after Lever A ($15) hit the risk-gate
// 50%-capacity cap. Meaningful stake growth requires either growing pool
// free collateral or bumping the risk-gate cap.
export const BASE_STAKE_USD = Number(process.env.POLYMARKET_EDGE_BASE_STAKE_USD || 5);
export const MAX_STAKE_USD = Number(process.env.POLYMARKET_EDGE_MAX_STAKE_USD || 500);
export const STAKE_PCT_OF_FREE = Number(process.env.POLYMARKET_EDGE_STAKE_PCT || 0.30);
// Autonomous exponential-growth driver — see original inline comment for the
// full ratio table.
export const DYNAMIC_BASE_PCT = Number(process.env.POLYMARKET_EDGE_DYNAMIC_BASE_PCT || 0.20);
export const LEVERAGE = Number(process.env.POLYMARKET_EDGE_LEVERAGE || 3);

// ── Funding-adjusted EV gate ─────────────────────────────────────────────
export const EV_FUNDING_APR = Number(process.env.POLYMARKET_EDGE_FUNDING_APR || 0.11);
export const EV_HOLDING_HOURS = Number(process.env.POLYMARKET_EDGE_HOLDING_HOURS || 0.5);
export const EV_FEE_BPS_ROUND_TRIP = Number(process.env.POLYMARKET_EDGE_FEE_BPS_RT || 13);
export const EV_MIN_USD = Number(process.env.POLYMARKET_EDGE_MIN_EV_USD || 0);

// ── Kill switch + slippage ───────────────────────────────────────────────
export const MAX_CONSECUTIVE_LOSSES = Number(process.env.POLYMARKET_EDGE_MAX_CONSECUTIVE_LOSSES || 5);
export const MAX_DRAWDOWN_PCT = Number(process.env.POLYMARKET_EDGE_MAX_DRAWDOWN_PCT || 0.30);
export const HALT_DURATION_MS = 24 * 60 * 60 * 1000;
export const MAX_SLIPPAGE_BPS = Number(process.env.POLYMARKET_EDGE_MAX_SLIPPAGE_BPS || 30);
export const DAILY_LOSS_CAP_USD = Number(
  process.env.POLYMARKET_EDGE_DAILY_LOSS_CAP_USD || -2 * BASE_STAKE_USD,
);
/** One full stake lost since the last such halt stops the trader for a day. 0 turns it off. */
export const CUMULATIVE_LOSS_CAP_USD = Number(
  process.env.POLYMARKET_EDGE_CUMULATIVE_LOSS_CAP_USD || BASE_STAKE_USD,
);

// ── Trailing stop + fee-bleed defer (resolved from trailing-stop config) ─
export const STOP_LOSS_BPS = DEFAULT_TRAILING_STOP_CONFIG.stopLossBps;
export const FEE_BREAKEVEN_BPS = DEFAULT_TRAILING_STOP_CONFIG.feeBreakevenBps;
export const DEFER_EXTEND_MS = DEFAULT_TRAILING_STOP_CONFIG.deferExtendMs;

// ── Signal-flip exit ─────────────────────────────────────────────────────
// Tightened from 50% → 30% so signal degradation triggers exit sooner.
export const SIGNAL_FLIP_SCORE_COLLAPSE = Number(
  process.env.POLYMARKET_EDGE_SIGNAL_FLIP_SCORE_COLLAPSE || 0.7,
);

// ── Signal-aligned defer at max-hold ─────────────────────────────────────
// Added 2026-08-14 after observing 13 SOL LONG opens/closes in one day
// where every close was max-hold expiry, and every re-open re-took the
// identical STRONG_HEDGE_LONG signal on the next tick. Each round-trip
// paid ~13 bps in fees for zero directional change → pure churn bleed.
// When max-hold expires but the signal is STILL STRONG_ + aligned + score
// not collapsed, extend the hold instead of close+reopen. Bounded to
// prevent forever-hold on a stubbornly-strong signal.
export const MAX_ALIGNED_DEFER_COUNT = Number(
  process.env.POLYMARKET_EDGE_MAX_ALIGNED_DEFER_COUNT || 6,
);

// ── Cron state keys ──────────────────────────────────────────────────────
export const KEY_ACTIVE = 'polymarket-edge:active-trade';
export const KEY_STATS = 'polymarket-edge:stats';
export const KEY_HALTED_UNTIL = CronKeys.polymarketEdgeHaltedUntil;
export const KEY_DAILY = 'polymarket-edge:daily';
export const KEY_LAST_SKIP = 'polymarket-edge:last-skip';
export const KEY_NOEDGE_STREAK = 'polymarket-edge:noedge-streak';
export const KEY_STARVATION_STREAK = 'polymarket-edge:starvation-streak';
export const KEY_STARVATION_ALERT_FLAG = 'polymarket-edge:starvation-alert-flag';

// Starvation alert config. When trader has skipped with 'no-collateral'
// for STARVATION_STREAK_THRESHOLD consecutive ticks (12 * 5min = 1h),
// fire ONE actionable KILL alert to Discord. Suppress subsequent
// alerts for STARVATION_ALERT_TTL_MS (24h) — same pattern as the
// stale-dust-flag suppression to avoid Discord spam. Reset streak on
// any non-starvation action (successful trade, no-edge, halt).
export const STARVATION_STREAK_THRESHOLD = 12;
export const STARVATION_ALERT_TTL_MS = 24 * 60 * 60 * 1000;

// Auto-topup config. When the alert fires, call bluefinTreasury.
// autoTopUp() to move admin spot USDC into the BlueFin margin bank
// (swaps SUI → USDC first if needed). Breaks the Catch-22 where the
// trader can't trade because free = $0 because hedges lock all margin
// because hedges can't close because free = $0.
//
// Default ON — the pattern from the 2026-07-31 refactor for defense
// gates ("live by default, kill switch available"). Safe as default
// because:
//   1. bluefinTreasury.autoTopUp is bounded by maxSwapSui + target
//      margin caps (no runaway).
//   2. Fires at most once per 24h (starvation alert TTL).
//   3. Money stays inside the pool — USDC just moves from admin
//      spot wallet to BlueFin margin bank. No external deposits.
//   4. Skips if margin is already above the floor.
// To disable: set TRADER_AUTO_TOPUP_ENABLED=0 in prod env.
export const TRADER_AUTO_TOPUP_ENABLED = envFlagOnByDefault('TRADER_AUTO_TOPUP_ENABLED');
export const TRADER_AUTO_TOPUP_MIN_MARGIN = Number(
  process.env.TRADER_AUTO_TOPUP_MIN_MARGIN || 20,
);
export const TRADER_AUTO_TOPUP_TARGET_MARGIN = Number(
  process.env.TRADER_AUTO_TOPUP_TARGET_MARGIN || 30,
);

// ── Skip-STRONG-signals gate ─────────────────────────────────────────────
// Historical outcome analysis (2026-08-28, 22 real trades) revealed a
// classic inverse-strength phenomenon:
//   HEDGE_LONG (moderate):    3 trades, 100% win, +$0.07 PnL
//   STRONG_HEDGE_LONG:       16 trades,  13% win, -$0.34 PnL
// "STRONG_" signals fire when Polymarket consensus is already high,
// which typically means the move is already priced in and mean-reversion
// follows. Skipping strong signals in favor of moderate ones flips the
// per-trade EV. Default ON with kill switch — set
// POLYMARKET_EDGE_SKIP_STRONG_SIGNALS=0 to re-enable if a trend-
// following regime returns.
export const POLYMARKET_EDGE_SKIP_STRONG_SIGNALS = envFlagOnByDefault(
  'POLYMARKET_EDGE_SKIP_STRONG_SIGNALS',
);

// ── Max-hold windows (minutes) ───────────────────────────────────────────
// Historical analysis (2026-08-28) showed EVERY closed trade hit exactly
// its max-hold expiry (~5 min for HEDGE_, 10 min for STRONG_). Trades
// weren't earning trailing-stop exits; they were dying at expiry after
// small random-walk moves that didn't clear 12 bp round-trip fees.
// Extending gives moves time to develop past the fee floor. If signal
// flips, signal-flip exit fires (before max-hold) — no downside to
// longer holds when signal exit is wired.
export const MAX_HOLD_MIN_MODERATE = Number(
  process.env.POLYMARKET_EDGE_MAX_HOLD_MODERATE_MIN || 20,
);
export const MAX_HOLD_MIN_STRONG = Number(
  process.env.POLYMARKET_EDGE_MAX_HOLD_STRONG_MIN || 30,
);
