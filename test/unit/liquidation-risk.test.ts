/**
 * The liquidation guard judges by the venue's liquidation price. Its earlier
 * estimate from the database row was an isolated-margin formula, wrong for a
 * cross-margin position, and its closes went to a route that did not exist.
 */
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
import { liquidationDistancePct, liquidationLevel } from '@/lib/services/sui/liquidation-risk';

describe('distance to liquidation, from venue figures', () => {
  it('the positions of 2026-10-12', () => {
    // SOL long 5x isolated: mark 108.996, venue liquidation 95.53
    expect(liquidationDistancePct({ side: 'LONG', markPrice: 108.996, liquidationPrice: 95.528927 })).toBeCloseTo(12.36, 1);
    // ETH short, cross margin: mark 2531.69, venue liquidation 3791.61
    expect(liquidationDistancePct({ side: 'SHORT', markPrice: 2531.69, liquidationPrice: 3791.61353 })).toBeCloseTo(49.77, 1);
  });

  it('the row-based estimate would have put that ETH short 6% away and closed it on a small rally', () => {
    const estimated = 2016.64 * (1 + 1 / 3);
    expect(liquidationLevel(liquidationDistancePct({ side: 'SHORT', markPrice: 2531.69, liquidationPrice: estimated }))).toBe('warning');
    expect(liquidationLevel(liquidationDistancePct({ side: 'SHORT', markPrice: 2570, liquidationPrice: estimated }))).toBe('emergency');
    // by the venue's figure it is healthy at both prices
    expect(liquidationLevel(liquidationDistancePct({ side: 'SHORT', markPrice: 2570, liquidationPrice: 3791.61 }))).toBe('healthy');
  });

  it('no liquidation price from the venue is unknown, never an emergency and never healthy', () => {
    expect(liquidationDistancePct({ side: 'LONG', markPrice: 1.0892, liquidationPrice: 0 })).toBeNull();
    expect(liquidationLevel(null)).toBe('unknown');
    expect(liquidationDistancePct({ side: 'LONG', markPrice: 0, liquidationPrice: 90 })).toBeNull();
  });

  it('levels: closes under 5%, warns under 10%', () => {
    const long = (mark: number) => liquidationLevel(liquidationDistancePct({ side: 'LONG', markPrice: mark, liquidationPrice: 95.53 }));
    expect(long(109)).toBe('healthy');
    expect(long(105)).toBe('warning');
    expect(long(100)).toBe('emergency');
    expect(long(95)).toBe('emergency'); // already through it
  });
});

describe('the protective jobs act through code that exists', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

  it('neither posts to the hedging-execute route, which was never there', () => {
    for (const p of ['app/api/cron/liquidation-guard/route.ts', 'app/api/cron/pool-nav-monitor/route.ts']) {
      expect(read(p)).not.toMatch(/agents\/hedging\/execute/);
    }
  });

  it('the guard reads positions strictly, claims before it closes, and closes on the venue', () => {
    const src = read('app/api/cron/liquidation-guard/route.ts');
    expect(src).toMatch(/getPositionsStrict\(\)/);
    expect(src.indexOf('tryClaimCronRun(')).toBeGreaterThan(-1);
    expect(src.indexOf('tryClaimCronRun(`liquidation-guard:close:')).toBeLessThan(src.indexOf('bf.closeHedge('));
  });

  it('the NAV monitor places no orders', () => {
    expect(read('app/api/cron/pool-nav-monitor/route.ts')).not.toMatch(/closeHedge|openHedge|AUTO-HEDGED/);
  });
});
