/**
 * The live trader lost on its first trade and never recovered: best-ever total
 * +$0.07, then 243 trades to -$22.53. The loss-streak and drawdown halts arm
 * only after $10 of profit and the daily cap is $10 a day, so nothing could
 * stop it. The cumulative-loss halt needs no profit to arm.
 */
import { describe, it, expect } from '@jest/globals';
import { evaluateKillSwitch, type KillSwitchStats } from '@/lib/services/trading/kill-switches';

const NOW = 1_800_000_000_000;
const CFG = {
  maxConsecutiveLosses: 5,
  maxDrawdownPct: 0.30,
  dailyLossCapUsd: -10,
  baseStakeUsd: 5,
  cumulativeLossCapUsd: 5,
  haltDurationMs: 24 * 60 * 60 * 1000,
  now: NOW,
};

/** Replays a run of per-trade results the way the trader's stats accumulate them. */
function replay(results: number[], start: KillSwitchStats = { totalPnlUsd: 0, peakPnlUsd: 0, consecutiveLosses: 0 }) {
  let stats = { ...start };
  const halts: Array<{ trade: number; reason?: string; total: number }> = [];
  results.forEach((r, i) => {
    const total = stats.totalPnlUsd + r;
    stats = { ...stats, totalPnlUsd: total, peakPnlUsd: Math.max(stats.peakPnlUsd, total), consecutiveLosses: r > 0 ? 0 : stats.consecutiveLosses + 1 };
    const d = evaluateKillSwitch(stats, { pnlUsd: 0 }, 0, CFG);
    if (d.trip) {
      halts.push({ trade: i + 1, reason: d.reason, total });
      if (d.newAnchorPnlUsd !== undefined) stats = { ...stats, haltAnchorPnlUsd: d.newAnchorPnlUsd };
    }
  });
  return { stats, halts };
}

describe('cumulative-loss halt', () => {
  it('the older conditions alone never halt a trader that only ever loses a little', () => {
    const d = evaluateKillSwitch(
      { totalPnlUsd: -22.53, peakPnlUsd: 0.07, consecutiveLosses: 9 },
      { pnlUsd: -2.6 },
      0, { ...CFG, cumulativeLossCapUsd: 0 },
    );
    expect(d.trip).toBe(false);
  });

  it('halts that trader once it has lost one stake, with no profit ever made', () => {
    // 58% small wins, larger losses, about -$0.093 a trade: the live record's shape.
    const results = Array.from({ length: 243 }, (_, i) => (i % 12 < 7 ? 0.05 : -0.293));
    const { halts } = replay(results);
    expect(halts.length).toBeGreaterThan(0);
    expect(halts[0].reason).toBe('cumulative-loss');
    expect(halts[0].trade).toBeLessThanOrEqual(60);
    expect(halts[0].total).toBeLessThanOrEqual(-5);
  });

  it('gives a fresh budget after each halt: the next one needs a further full stake of losses', () => {
    const results = Array.from({ length: 243 }, (_, i) => (i % 12 < 7 ? 0.05 : -0.293));
    const { halts, stats } = replay(results);
    expect(halts.length).toBe(4); // about every $5 of the $22.5 lost
    for (let i = 1; i < halts.length; i++) expect(halts[i - 1].total - halts[i].total).toBeGreaterThanOrEqual(5);
    expect(stats.haltAnchorPnlUsd).toBe(halts[halts.length - 1].total);
  });

  it('the production record as it stands (-$22.53, no anchor) halts at its next close and anchors there', () => {
    const d = evaluateKillSwitch({ totalPnlUsd: -22.53, peakPnlUsd: 0.07, consecutiveLosses: 1 }, { pnlUsd: -0.31 }, 0, CFG);
    expect(d).toMatchObject({ trip: true, reason: 'cumulative-loss', newAnchorPnlUsd: -22.53 });
    expect(d.detail).toMatch(/lost \$22\.53 since the last halt/);
    const after = evaluateKillSwitch({ totalPnlUsd: -22.8, peakPnlUsd: 0.07, consecutiveLosses: 2, haltAnchorPnlUsd: -22.53 }, { pnlUsd: -0.27 }, 0, CFG);
    expect(after.trip).toBe(false);
  });

  it('does not fire on a profitable trader giving back less than a stake from its anchor', () => {
    const d = evaluateKillSwitch({ totalPnlUsd: 3, peakPnlUsd: 7, consecutiveLosses: 2 }, { pnlUsd: -4 }, 0, CFG);
    expect(d.trip).toBe(false);
  });

  it('a cap of 0 turns it off', () => {
    const d = evaluateKillSwitch({ totalPnlUsd: -100, peakPnlUsd: 0, consecutiveLosses: 1 }, { pnlUsd: 0 }, 0, { ...CFG, cumulativeLossCapUsd: 0 });
    expect(d.trip).toBe(false);
  });

  it('an older condition that fires first still re-anchors when the cap is also spent', () => {
    const d = evaluateKillSwitch({ totalPnlUsd: -12, peakPnlUsd: 0, consecutiveLosses: 1 }, { pnlUsd: -11 }, 0, CFG);
    expect(d).toMatchObject({ trip: true, reason: 'daily-cap', newAnchorPnlUsd: -12 });
  });
});
