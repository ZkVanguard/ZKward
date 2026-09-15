/**
 * Unit tests for evaluateSignalFlip — the pure decision function extracted
 * from reconcile-active-trade so the confidence gate is unit testable.
 *
 * Regression this locks: 2026-09-15 SOL churn — trader opened HEDGE_SHORT at
 * ~60% conf, next 5-min re-scan came back LIGHT_HEDGE_SHORT at ~45% conf,
 * `isActionable(LIGHT_...)` returned false → flipReason fired → close at $0
 * → repeat every 5 min. Confidence gate makes low-conf re-scans a no-op.
 */
import { describe, it, expect } from '@jest/globals';
import { evaluateSignalFlip } from '@/app/api/cron/polymarket-edge-trader/handlers/signal-flip';

const baseActive = { side: 'SHORT' as const, entryScore: 60 };

function pred(rec: string, conf: number) {
  return { recommendation: rec as any, confidence: conf };
}

describe('evaluateSignalFlip — confidence gate', () => {
  it('does NOT fire on demotion when new confidence < minConfidence', async () => {
    const reason = evaluateSignalFlip({
      active: baseActive,
      livePred: pred('LIGHT_HEDGE_SHORT', 45),
      liveScore: 40,
      minConfidence: 55,
      scoreCollapseRatio: 0.7,
    });
    expect(reason).toBeNull();
  });

  it('does NOT fire on direction flip when new confidence < minConfidence', async () => {
    const reason = evaluateSignalFlip({
      active: baseActive,
      livePred: pred('HEDGE_LONG', 50),
      liveScore: 40,
      minConfidence: 55,
      scoreCollapseRatio: 0.7,
    });
    expect(reason).toBeNull();
  });

  it('does NOT fire on score collapse when new confidence < minConfidence', async () => {
    const reason = evaluateSignalFlip({
      active: baseActive,
      livePred: pred('HEDGE_SHORT', 50),
      liveScore: 10,
      minConfidence: 55,
      scoreCollapseRatio: 0.7,
    });
    expect(reason).toBeNull();
  });

  it('DOES fire on demotion when new confidence >= minConfidence', async () => {
    const reason = evaluateSignalFlip({
      active: baseActive,
      livePred: pred('LIGHT_HEDGE_SHORT', 60),
      liveScore: 40,
      minConfidence: 55,
      scoreCollapseRatio: 0.7,
    });
    expect(reason).toMatch(/demoted/);
  });

  it('DOES fire on direction flip when new confidence >= minConfidence', async () => {
    const reason = evaluateSignalFlip({
      active: baseActive,
      livePred: pred('HEDGE_LONG', 70),
      liveScore: 55,
      minConfidence: 55,
      scoreCollapseRatio: 0.7,
    });
    expect(reason).toMatch(/flipped/);
  });

  it('DOES fire on score collapse when new confidence >= minConfidence', async () => {
    const reason = evaluateSignalFlip({
      active: baseActive,
      livePred: pred('HEDGE_SHORT', 65),
      liveScore: 20,
      minConfidence: 55,
      scoreCollapseRatio: 0.7,
    });
    expect(reason).toMatch(/score collapsed/);
  });

  it('does NOT fire when signal is unchanged (same side, actionable, score healthy)', async () => {
    const reason = evaluateSignalFlip({
      active: baseActive,
      livePred: pred('HEDGE_SHORT', 65),
      liveScore: 55,
      minConfidence: 55,
      scoreCollapseRatio: 0.7,
    });
    expect(reason).toBeNull();
  });

  it('confidence gate at exact minConfidence boundary — treated as pass', async () => {
    const reason = evaluateSignalFlip({
      active: baseActive,
      livePred: pred('LIGHT_HEDGE_SHORT', 55),
      liveScore: 40,
      minConfidence: 55,
      scoreCollapseRatio: 0.7,
    });
    expect(reason).toMatch(/demoted/);
  });

  it('handles missing confidence (defaults to 0) — no flip', async () => {
    const reason = evaluateSignalFlip({
      active: baseActive,
      livePred: { recommendation: 'LIGHT_HEDGE_SHORT' as any, confidence: undefined as any },
      liveScore: 40,
      minConfidence: 55,
      scoreCollapseRatio: 0.7,
    });
    expect(reason).toBeNull();
  });
});
