/**
 * Unit tests for evaluateAutoResponse — Gap 8 pure logic.
 *
 * The cron wrapper (app/api/cron/alert-response-loop/route.ts) reads
 * from cron_state; the pure function evaluated here is what decides
 * what to do given the state. Locks the three rules:
 *   - 3 KILL alerts in 60 min → SHRINK_SPOT
 *   - profit-lock zero-tier > 24h → UNWIND_ALL_SPOT
 *   - phantom rate > 1% → HALT_TRADER + HALT_AUTOHEDGE
 *
 * Regression risk: threshold drift on any of these rules changes the
 * production auto-response cadence; the alert-response cron ships live.
 */
import { describe, it, expect } from '@jest/globals';
import type { AlertLevel } from '@/lib/services/alerting/alert-response-loop';
import { evaluateAutoResponse } from '@/lib/services/alerting/alert-response-loop';

const NOW = Date.now();
const min = (n: number) => NOW - n * 60 * 1000;

function kill(atMinAgo: number, message = 'test'): { at: number; level: AlertLevel; message: string } {
  return { at: min(atMinAgo), level: 'KILL', message };
}
function warn(atMinAgo: number, message = 'test'): { at: number; level: AlertLevel; message: string } {
  return { at: min(atMinAgo), level: 'WARN', message };
}

describe('evaluateAutoResponse — SHRINK_SPOT rule (3 KILL in 60min)', () => {
  it('fires when exactly 3 KILL alerts in last 60 min', async () => {
    const responses = await evaluateAutoResponse({
      alertLog: [kill(45), kill(20), kill(5)],
      now: NOW,
    });
    const shrinks = responses.filter(r => r.type === 'SHRINK_SPOT');
    expect(shrinks).toHaveLength(1);
    expect(shrinks[0].triggeredBy).toHaveLength(3);
  });

  it('does NOT fire on only 2 KILL alerts', async () => {
    const responses = await evaluateAutoResponse({
      alertLog: [kill(45), kill(20)],
      now: NOW,
    });
    const shrinks = responses.filter(r => r.type === 'SHRINK_SPOT');
    expect(shrinks).toHaveLength(0);
  });

  it('excludes KILL alerts older than 60 min', async () => {
    const responses = await evaluateAutoResponse({
      alertLog: [kill(90), kill(80), kill(70), kill(30)], // 3 old + 1 recent
      now: NOW,
    });
    expect(responses.filter(r => r.type === 'SHRINK_SPOT')).toHaveLength(0);
  });

  it('ignores non-KILL alerts in the count', async () => {
    const responses = await evaluateAutoResponse({
      alertLog: [kill(45), warn(30), warn(20), warn(10)],
      now: NOW,
    });
    expect(responses.filter(r => r.type === 'SHRINK_SPOT')).toHaveLength(0);
  });

  // Cross-chain isolation: KILL alerts emitted by non-SUI chains (Hedera,
  // Sepolia, etc.) MUST NOT halt the SUI pool. Guards against a future
  // EVM cron misfire cascading into a SUI trader halt.
  it('does NOT fire when 3 KILLs come from a non-SUI chain (Hedera)', async () => {
    const hederaKill = (atMinAgo: number) => ({
      ...kill(atMinAgo, 'hedera trip'),
      chain: 'hedera',
    });
    const responses = await evaluateAutoResponse({
      alertLog: [hederaKill(45), hederaKill(20), hederaKill(5)],
      now: NOW,
    });
    expect(responses.filter(r => r.type === 'SHRINK_SPOT')).toHaveLength(0);
  });

  it('fires when 3 KILLs are explicitly tagged chain=sui', async () => {
    const suiKill = (atMinAgo: number) => ({ ...kill(atMinAgo), chain: 'sui' });
    const responses = await evaluateAutoResponse({
      alertLog: [suiKill(45), suiKill(20), suiKill(5)],
      now: NOW,
    });
    expect(responses.filter(r => r.type === 'SHRINK_SPOT')).toHaveLength(1);
  });

  it('counts untagged KILLs as SUI (legacy backfill safety)', async () => {
    const responses = await evaluateAutoResponse({
      alertLog: [kill(45), kill(20), kill(5)],
      now: NOW,
    });
    expect(responses.filter(r => r.type === 'SHRINK_SPOT')).toHaveLength(1);
  });

  it('mixed SUI + Hedera KILLs: only SUI count toward threshold', async () => {
    const hederaKill = (atMinAgo: number) => ({ ...kill(atMinAgo), chain: 'hedera' });
    const suiKill = (atMinAgo: number) => ({ ...kill(atMinAgo), chain: 'sui' });
    // 2 SUI + 5 Hedera = below SUI threshold
    const responses = await evaluateAutoResponse({
      alertLog: [
        suiKill(45), suiKill(20),
        hederaKill(50), hederaKill(40), hederaKill(30), hederaKill(15), hederaKill(3),
      ],
      now: NOW,
    });
    expect(responses.filter(r => r.type === 'SHRINK_SPOT')).toHaveLength(0);
  });
});

describe('evaluateAutoResponse — UNWIND_ALL_SPOT rule (24h profit-lock)', () => {
  it('fires when profit-lock zero-tier has been > 24h', async () => {
    const responses = await evaluateAutoResponse({
      alertLog: [],
      now: NOW,
      profitLockZeroSinceMs: NOW - 25 * 60 * 60 * 1000, // 25h ago
    });
    expect(responses.filter(r => r.type === 'UNWIND_ALL_SPOT')).toHaveLength(1);
  });

  it('does NOT fire when profit-lock zero-tier is exactly 24h', async () => {
    const responses = await evaluateAutoResponse({
      alertLog: [],
      now: NOW,
      profitLockZeroSinceMs: NOW - 24 * 60 * 60 * 1000, // exactly 24h
    });
    expect(responses.filter(r => r.type === 'UNWIND_ALL_SPOT')).toHaveLength(0);
  });

  it('does NOT fire when profitLockZeroSinceMs is undefined', async () => {
    const responses = await evaluateAutoResponse({
      alertLog: [],
      now: NOW,
    });
    expect(responses.filter(r => r.type === 'UNWIND_ALL_SPOT')).toHaveLength(0);
  });
});

describe('evaluateAutoResponse — phantom rate rule', () => {
  it('fires HALT_TRADER + HALT_AUTOHEDGE when rate > 1% and sample >= 5', async () => {
    const responses = await evaluateAutoResponse({
      alertLog: [],
      now: NOW,
      phantomRatePctLastHour: 2.5,
      phantomTotalLastHour: 10,
    });
    expect(responses.filter(r => r.type === 'HALT_TRADER')).toHaveLength(1);
    expect(responses.filter(r => r.type === 'HALT_AUTOHEDGE')).toHaveLength(1);
  });

  it('does NOT fire at exactly 1%', async () => {
    const responses = await evaluateAutoResponse({
      alertLog: [],
      now: NOW,
      phantomRatePctLastHour: 1.0,
      phantomTotalLastHour: 10,
    });
    expect(responses.filter(r => r.type === 'HALT_TRADER')).toHaveLength(0);
  });

  it('does NOT fire at 0% (healthy)', async () => {
    const responses = await evaluateAutoResponse({
      alertLog: [],
      now: NOW,
      phantomRatePctLastHour: 0,
      phantomTotalLastHour: 10,
    });
    expect(responses).toEqual([]);
  });

  it('does NOT fire when phantomRatePctLastHour is undefined', async () => {
    const responses = await evaluateAutoResponse({
      alertLog: [],
      now: NOW,
    });
    expect(responses).toEqual([]);
  });

  // Sample-size gate: single-fill 100% rate is not proof of exchange failure.
  // Real regression: 2026-09-15 one legitimate zero-move SOL close in a quiet
  // hour tripped rate=100% and false-halted both trader + autohedge for 24h.
  it('does NOT fire on 100% rate with 1-close sample (false-halt guard)', async () => {
    const responses = await evaluateAutoResponse({
      alertLog: [],
      now: NOW,
      phantomRatePctLastHour: 100,
      phantomTotalLastHour: 1,
    });
    expect(responses).toEqual([]);
  });

  it('does NOT fire on 100% rate with 4-close sample (just below gate)', async () => {
    const responses = await evaluateAutoResponse({
      alertLog: [],
      now: NOW,
      phantomRatePctLastHour: 100,
      phantomTotalLastHour: 4,
    });
    expect(responses).toEqual([]);
  });

  it('DOES fire on 20% rate with 5-close sample (gate boundary)', async () => {
    const responses = await evaluateAutoResponse({
      alertLog: [],
      now: NOW,
      phantomRatePctLastHour: 20,
      phantomTotalLastHour: 5,
    });
    expect(responses.filter(r => r.type === 'HALT_TRADER')).toHaveLength(1);
  });

  it('does NOT fire when phantomTotalLastHour is undefined (defensive default)', async () => {
    const responses = await evaluateAutoResponse({
      alertLog: [],
      now: NOW,
      phantomRatePctLastHour: 50,
    });
    expect(responses).toEqual([]);
  });
});

describe('evaluateAutoResponse — in-flight phantom-open rule', () => {
  it('fires HALT_TRADER + HALT_AUTOHEDGE when inFlightPhantomOpenCount >= 1', async () => {
    const responses = await evaluateAutoResponse({
      alertLog: [],
      now: NOW,
      inFlightPhantomOpenCount: 1,
    });
    expect(responses.filter(r => r.type === 'HALT_TRADER')).toHaveLength(1);
    expect(responses.filter(r => r.type === 'HALT_AUTOHEDGE')).toHaveLength(1);
    expect(responses[0].reason).toMatch(/in-flight phantom open/);
  });

  it('does NOT fire at 0 in-flight phantoms', async () => {
    const responses = await evaluateAutoResponse({
      alertLog: [],
      now: NOW,
      inFlightPhantomOpenCount: 0,
    });
    expect(responses).toEqual([]);
  });

  it('fires independently of phantomRatePctLastHour (closed-rate at 0%)', async () => {
    // The whole point of this rule: closed-rate is 0% during the 15-min
    // reconciler window, but in-flight opens ARE the phantom signal.
    const responses = await evaluateAutoResponse({
      alertLog: [],
      now: NOW,
      phantomRatePctLastHour: 0,
      inFlightPhantomOpenCount: 2,
    });
    expect(responses.filter(r => r.type === 'HALT_TRADER')).toHaveLength(1);
  });
});

describe('evaluateAutoResponse — composition', () => {
  it('emits multiple responses when multiple rules trigger', async () => {
    const responses = await evaluateAutoResponse({
      alertLog: [kill(45), kill(20), kill(5)],
      now: NOW,
      profitLockZeroSinceMs: NOW - 26 * 60 * 60 * 1000,
      phantomRatePctLastHour: 3,
      phantomTotalLastHour: 10,
    });
    // SHRINK_SPOT + UNWIND_ALL_SPOT + HALT_TRADER + HALT_AUTOHEDGE = 4
    expect(responses).toHaveLength(4);
    const types = responses.map(r => r.type).sort();
    expect(types).toEqual(['HALT_AUTOHEDGE', 'HALT_TRADER', 'SHRINK_SPOT', 'UNWIND_ALL_SPOT'].sort());
  });

  it('emits empty array on baseline healthy state', async () => {
    const responses = await evaluateAutoResponse({
      alertLog: [],
      now: NOW,
    });
    expect(responses).toEqual([]);
  });

  it('every response has non-empty reason string', async () => {
    const responses = await evaluateAutoResponse({
      alertLog: [kill(45), kill(20), kill(5)],
      now: NOW,
      profitLockZeroSinceMs: NOW - 26 * 60 * 60 * 1000,
      phantomRatePctLastHour: 3,
      phantomTotalLastHour: 10,
    });
    for (const r of responses) {
      expect(r.reason).toBeTruthy();
      expect(r.reason.length).toBeGreaterThan(5);
    }
  });
});
