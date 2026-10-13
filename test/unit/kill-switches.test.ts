/**
 * Contract lock for the polymarket-edge-trader kill-switch evaluator.
 *
 * This is capital-critical: a wrong decision either lets a bleeding
 * trader keep bleeding, or halts a healthy trader for 24h. Anchoring
 * every branch of the 3-condition trip logic — plus the peak-floor
 * regression guard that fixed the 2026-07-13 $0.10-win-then-loss trip.
 */
import { describe, it, expect } from '@jest/globals';
import { evaluateKillSwitch } from '@/lib/services/trading/kill-switches';

const NOW = 1_800_000_000_000;
const CFG = {
  maxConsecutiveLosses: 5,
  maxDrawdownPct: 0.30,
  dailyLossCapUsd: -10,
  baseStakeUsd: 5,
  cumulativeLossCapUsd: 0, // off here: these cases pin the three older conditions
  haltDurationMs: 24 * 60 * 60 * 1000,
  now: NOW,
};

describe('evaluateKillSwitch', () => {
  it('no trip when everything is healthy', () => {
    const d = evaluateKillSwitch(
      { totalPnlUsd: 5, peakPnlUsd: 5, consecutiveLosses: 0 },
      { pnlUsd: 0 },
      0, CFG,
    );
    expect(d.trip).toBe(false);
    expect(d.halted).toBe(false);
  });

  it('trips on 5 consecutive losses when peak is meaningful', () => {
    // Peak $25 >= floor $10 → losses trip fires.
    const d = evaluateKillSwitch(
      { totalPnlUsd: -20, peakPnlUsd: 25, consecutiveLosses: 5 },
      { pnlUsd: -8 },
      0, CFG,
    );
    expect(d.trip).toBe(true);
    expect(d.reason).toBe('consecutive-losses');
    expect(d.untilMs).toBe(NOW + CFG.haltDurationMs);
  });

  it('does NOT trip on 5 consecutive losses when peak is below floor (2026-08-01 regression)', () => {
    // 5 losses of $0.10 each: consecutiveLosses=5, totalPnl=-$0.50, peak=$0.58
    // Peak $0.58 < floor $10 → no trip (statistical noise, not broken strategy).
    const d = evaluateKillSwitch(
      { totalPnlUsd: -0.50, peakPnlUsd: 0.58, consecutiveLosses: 5 },
      { pnlUsd: -0.50 },
      0, CFG,
    );
    expect(d.trip).toBe(false);
    expect(d.peakMeaningful).toBe(false);
  });

  it('trips on 30% drawdown when peak is meaningful (>= 2×BASE_STAKE)', () => {
    // peak $10 (>= max(2*5, 5) = 10), drop 30% → total $7
    const d = evaluateKillSwitch(
      { totalPnlUsd: 7, peakPnlUsd: 10, consecutiveLosses: 1 },
      { pnlUsd: 0 },
      0, CFG,
    );
    expect(d.trip).toBe(true);
    expect(d.reason).toBe('drawdown');
    expect(d.peakMeaningful).toBe(true);
  });

  it('does NOT trip on drawdown when peak is below floor (the 2026-07-13 regression)', () => {
    // $0.10 win → peak = $0.10, then $0.10 loss → total = 0
    // Drawdown = 100% but peak floor is $10 (max(2*5, 5)) → no trip.
    const d = evaluateKillSwitch(
      { totalPnlUsd: 0, peakPnlUsd: 0.10, consecutiveLosses: 1 },
      { pnlUsd: -0.10 },
      0, CFG,
    );
    expect(d.trip).toBe(false);
    expect(d.peakMeaningful).toBe(false);
    expect(d.drawdownPct).toBeGreaterThan(0.5); // drawdown IS 100% mathematically
  });

  it('arms drawdown trip at new $10 floor (2026-08-14 lowered from $20)', () => {
    // Regression: at peak $12 (< old $20 floor, >= new $10 floor) with 40% drawdown,
    // old code left kill switch muted → strategy that never got past $20 could bleed
    // indefinitely. New floor arms the guard when trader has 2 base stakes accumulated.
    const d = evaluateKillSwitch(
      { totalPnlUsd: 7, peakPnlUsd: 12, consecutiveLosses: 1 },
      { pnlUsd: 0 },
      0, CFG,
    );
    expect(d.trip).toBe(true);
    expect(d.reason).toBe('drawdown');
    expect(d.peakMeaningful).toBe(true);
  });

  it('trips on daily loss cap breach', () => {
    const d = evaluateKillSwitch(
      { totalPnlUsd: -5, peakPnlUsd: 8, consecutiveLosses: 2 },
      { pnlUsd: -12 }, // exceeds -10 cap
      0, CFG,
    );
    expect(d.trip).toBe(true);
    expect(d.reason).toBe('daily-cap');
    expect(d.detail).toContain('-12');
  });

  it('daily cap trip fires exactly at the cap (≤ not <)', () => {
    const d = evaluateKillSwitch(
      { totalPnlUsd: 0, peakPnlUsd: 0, consecutiveLosses: 0 },
      { pnlUsd: -10 }, // exactly equal
      0, CFG,
    );
    expect(d.trip).toBe(true);
    expect(d.reason).toBe('daily-cap');
  });

  it('halted=true when currentHaltUntilMs is in future (no fresh trip)', () => {
    const d = evaluateKillSwitch(
      { totalPnlUsd: 5, peakPnlUsd: 5, consecutiveLosses: 0 },
      { pnlUsd: 0 },
      NOW + 60_000, // still 1min of halt remaining
      CFG,
    );
    expect(d.trip).toBe(false);
    expect(d.halted).toBe(true);
  });

  it('losses trip takes priority over drawdown / daily-cap when all fire', () => {
    // All three conditions fire; verify losses wins the reason
    const d = evaluateKillSwitch(
      { totalPnlUsd: -100, peakPnlUsd: 50, consecutiveLosses: 6 },
      { pnlUsd: -50 },
      0, CFG,
    );
    expect(d.trip).toBe(true);
    expect(d.reason).toBe('consecutive-losses');
  });
});
