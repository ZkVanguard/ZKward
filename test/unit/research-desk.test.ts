import { describe, it, expect } from '@jest/globals';
import {
  parseRule,
  parseProposals,
  ruleKey,
  featureSeries,
  backtest,
  barFor,
  buildPrompt,
  TREND_RULE,
  type Series,
} from '@/lib/services/ai/research-desk';

const DAY = 86_400_000;
const series = (close: number[]): Series => ({ t: close.map((_, i) => i * DAY), close });

describe('research desk: rules from model output', () => {
  it('accepts a valid rule and normalises it', () => {
    const r = parseRule({ asset: 'btc', exposure: 0.333, when: [{ feature: 'maGap', days: 50, op: '>', value: 1.234 }] });
    expect(r).toEqual({ asset: 'BTC', exposure: 0.33, when: [{ feature: 'maGap', days: 50, op: '>', value: 1.23 }] });
  });

  it.each([
    [{ asset: 'SOL', exposure: 0.5, when: [{ feature: 'ret', days: 5, op: '>', value: 0 }] }],
    [{ asset: 'BTC', exposure: 1.5, when: [{ feature: 'ret', days: 5, op: '>', value: 0 }] }],
    [{ asset: 'BTC', exposure: 0.5, when: [{ feature: 'rsi', days: 5, op: '>', value: 0 }] }],
    [{ asset: 'BTC', exposure: 0.5, when: [{ feature: 'ret', days: 500, op: '>', value: 0 }] }],
    [{ asset: 'BTC', exposure: 0.5, when: [{ feature: 'ret', days: 5, op: '>=', value: 0 }] }],
    [{ asset: 'BTC', exposure: 0.5, when: [] }],
    [{ asset: 'BTC', exposure: 0.5, when: Array(4).fill({ feature: 'ret', days: 5, op: '>', value: 0 }) }],
  ])('rejects %j', (bad) => {
    expect(parseRule(bad)).toBeNull();
  });

  it('gives the same key whatever the condition order', () => {
    const a = parseRule({ asset: 'ETH', exposure: 0.5, when: [{ feature: 'vol', days: 30, op: '<', value: 60 }, { feature: 'ret', days: 5, op: '>', value: 0 }] })!;
    const b = parseRule({ asset: 'ETH', exposure: 0.5, when: [{ feature: 'ret', days: 5, op: '>', value: 0 }, { feature: 'vol', days: 30, op: '<', value: 60 }] })!;
    expect(ruleKey(a)).toBe(ruleKey(b));
  });

  it('reads a JSON array out of prose and drops malformed entries', () => {
    const text = `The results suggest trend works.\n[{"hypothesis":"h1","rule":{"asset":"BTC","exposure":0.5,"when":[{"feature":"ret","days":20,"op":">","value":0}]}},{"rule":{"asset":"XRP"}}]\nDone.`;
    const out = parseProposals(text);
    expect(out).toHaveLength(1);
    expect(out[0].hypothesis).toBe('h1');
    expect(parseProposals('no json here')).toEqual([]);
  });
});

describe('research desk: features and the test', () => {
  it('computes return, average gap and fall from high in percent', () => {
    const s = series([100, 110, 121, 100]);
    expect(featureSeries(s, 'ret', 1)[1]).toBeCloseTo(10);
    expect(featureSeries(s, 'maGap', 2)[1]).toBeCloseTo((110 / 105 - 1) * 100);
    expect(featureSeries(s, 'drawdown', 3)[3]).toBeCloseTo((100 / 121 - 1) * 100);
    expect(Number.isNaN(featureSeries(s, 'ret', 2)[1])).toBe(true);
  });

  it('a rule always in the market matches holding, minus one entry cost', () => {
    const s = series(Array.from({ length: 50 }, (_, i) => 100 * (1 + 0.01 * Math.sin(i))));
    const sc = backtest({ asset: 'BTC', exposure: 0.5, when: [{ feature: 'ret', days: 2, op: '>', value: -1000 }] }, s, 3 * DAY, 50 * DAY);
    expect(sc.changes).toBe(1);
    expect(sc.inMarketPct).toBe(100);
    expect(sc.returnPct).toBeLessThan(sc.holdReturnPct);
    expect(sc.holdReturnPct - sc.returnPct).toBeLessThan(0.1);
  });

  it('timing that dodges every down day shows a positive edge', () => {
    // Up after an up day, down after a down day: momentum the rule can exploit.
    const moves = Array.from({ length: 400 }, (_, i) => (Math.floor(i / 5) % 2 ? -0.02 : 0.02));
    const close = [100];
    for (const m of moves) close.push(close.at(-1)! * (1 + m));
    const sc = backtest({ asset: 'BTC', exposure: 1, when: [{ feature: 'ret', days: 1, op: '>', value: 0 }] }, series(close), DAY, close.length * DAY);
    expect(sc.edgeT).toBeGreaterThan(2);
    expect(sc.returnPct).toBeGreaterThan(sc.holdReturnPct);
  });

  it('the bar rises with the number of rules tried', () => {
    expect(barFor(1)).toBe(2);
    expect(barFor(100)).toBeGreaterThan(barFor(10));
    expect(barFor(1000)).toBeCloseTo(3.72, 1);
  });

  it('the prompt shows training results only and names the bar', () => {
    const p = buildPrompt([], { days: 1, returnPct: 1, holdReturnPct: 2, edgeT: -0.2, maxDrawdownPct: 1, inMarketPct: 50, changes: 3 });
    expect(p).toContain(JSON.stringify(TREND_RULE));
    expect(p).toContain('No rules tried yet.');
    expect(p).not.toMatch(/held[- ]out/i);
  });
});
