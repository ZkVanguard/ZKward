/**
 * L6 — Multi-armed bandit for (asset, side).
 *
 * Currently every asset gets treated equally by the aggregator's picker —
 * whichever asset has the strongest signal at tick time gets the trade.
 * But historically we've lost money on some (asset, side) combos (DOGE
 * SHORT tried 30 times, lost 30 times) while never getting enough
 * exposure to profitable arms.
 *
 * Fix: treat each (asset, side) as an arm of a multi-armed bandit.
 * Every trade closes with a reward (realized PnL / notional) that
 * updates the arm's estimate. On next selection, UCB1 scores balance
 * "this arm has been profitable" against "we haven't tried this arm
 * enough to know."
 *
 * UCB1 formula:
 *   score = mean_reward + C × sqrt(2 × ln(total_pulls) / arm_pulls)
 *
 * The bonus term is huge for under-explored arms — they get a
 * cold-start boost so the bandit doesn't over-exploit a small early
 * winning streak. Once total_pulls grows, the term shrinks and
 * exploitation dominates.
 *
 * Wiring: this module returns a multiplier that the entry picker
 * applies to the signal-strength score. Multiplier > 1 = boost the arm,
 * < 1 = suppress. Cold-start arms return exactly 1 (neutral) so nothing
 * is worse than the pre-bandit behaviour.
 */

import { getCronState, setCronState } from '@/lib/db/cron-state';
import { logger } from '@/lib/utils/logger';
import { errMsg } from '@/lib/utils/error-handler';
import type { Side } from './simulated-executor';

const BANDIT_KEY = 'paper-trader:bandit:arms';
// UCB1 exploration constant. Higher = more exploration of under-tried
// arms; lower = faster exploitation of proven winners. 2 is textbook;
// we run at 1.4 to bias slightly toward exploitation once we have
// data (this trader is on a small pool, wasted exploration is expensive).
const EXPLORATION_C = Number(process.env.PAPER_TRADER_BANDIT_EXPLORATION_C || 1.4);
// After N trades on an arm we trust its mean and stop giving it a
// cold-start boost. Under this, the arm gets a +∞ UCB bonus so it
// gets tried at least once regardless of alternatives.
const COLD_START_TRADES = 3;
// Clamp so a single lucky trade can't dominate.
const MIN_MULT = 0.3;
const MAX_MULT = 2.0;

export interface BanditArm {
  key: string;              // "BTC:LONG"
  trades: number;
  totalRewardPct: number;   // sum of (realizedPnl / notionalUsd)
  wins: number;
  lastPulledAt: number;
}

export type BanditArms = Record<string, BanditArm>;

export function armKey(asset: string, side: Side): string {
  return `${asset.toUpperCase()}:${side}`;
}

async function loadArms(): Promise<BanditArms> {
  return (await getCronState<BanditArms>(BANDIT_KEY)) ?? {};
}

async function saveArms(arms: BanditArms): Promise<void> {
  await setCronState(BANDIT_KEY, arms);
}

/**
 * Record the outcome of a closed trade. Called from PaperTrader.closeAtMark.
 * rewardPct is the trade's realized PnL as a fraction of its notional so
 * different-sized arms are comparable.
 */
export async function recordArmOutcome(
  asset: string,
  side: Side,
  rewardPct: number,
  now: number = Date.now(),
): Promise<void> {
  try {
    const key = armKey(asset, side);
    const arms = await loadArms();
    const prev = arms[key] ?? { key, trades: 0, totalRewardPct: 0, wins: 0, lastPulledAt: 0 };
    arms[key] = {
      key,
      trades: prev.trades + 1,
      totalRewardPct: prev.totalRewardPct + rewardPct,
      wins: prev.wins + (rewardPct > 0 ? 1 : 0),
      lastPulledAt: now,
    };
    await saveArms(arms);
  } catch (e) {
    logger.debug('[Bandit] recordArmOutcome failed (non-fatal)', { asset, side, error: errMsg(e) });
  }
}

/**
 * Compute the UCB1-derived score multiplier for an (asset, side) arm.
 *
 *   • Cold-start (< COLD_START_TRADES pulls): return 1 (neutral).
 *     The regular signal-strength picker gets to explore.
 *   • Established: return clamp(exp(ucb_score), MIN_MULT, MAX_MULT).
 *     The exp() maps a mildly-negative UCB (bad arm) to a fractional
 *     multiplier and a mildly-positive UCB (good arm) to a boost.
 */
export async function getArmMultiplier(asset: string, side: Side): Promise<number> {
  try {
    const arms = await loadArms();
    const target = arms[armKey(asset, side)];
    if (!target || target.trades < COLD_START_TRADES) return 1;

    const totalPulls = Object.values(arms).reduce((sum, a) => sum + a.trades, 0);
    if (totalPulls < COLD_START_TRADES) return 1;

    const meanReward = target.totalRewardPct / target.trades;
    const bonus = EXPLORATION_C * Math.sqrt((2 * Math.log(totalPulls)) / target.trades);
    const ucb = meanReward + bonus;
    // Map a UCB expressed in "reward pct" units to a multiplier by
    // exp() — since rewards are tiny fractions like ±0.003, this maps
    // to multipliers close to 1 with slight boost/suppression.
    const mult = Math.exp(ucb * 20); // scale factor tuned so ±0.05 reward maps to ~2.7×/0.37×
    return Math.max(MIN_MULT, Math.min(MAX_MULT, mult));
  } catch (e) {
    logger.debug('[Bandit] getArmMultiplier failed (non-fatal)', { asset, side, error: errMsg(e) });
    return 1;
  }
}

/**
 * Read the full arm table for the /paper dashboard or an admin route.
 * Returns arms sorted by mean reward descending.
 */
export async function getArmStats(): Promise<BanditArm[]> {
  const arms = await loadArms();
  return Object.values(arms).sort((a, b) => {
    const meanA = a.trades > 0 ? a.totalRewardPct / a.trades : 0;
    const meanB = b.trades > 0 ? b.totalRewardPct / b.trades : 0;
    return meanB - meanA;
  });
}

// Test-only exports
export {
  BANDIT_KEY as _BANDIT_KEY,
  EXPLORATION_C as _EXPLORATION_C,
  COLD_START_TRADES as _COLD_START_TRADES,
};
