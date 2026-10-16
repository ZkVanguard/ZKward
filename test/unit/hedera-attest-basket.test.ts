/**
 * The consensus topic is the project's public record and each message costs
 * the operator's HBAR, so a basket from the browser is attested only at real
 * prices with sane numbers, and only once per interval across all callers.
 */
import { describe, it, expect } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import { basketProblem, type AttestPosition } from '@/lib/services/hedera/attest-basket';

const live = { BTC: 100_000, ETH: 4_000, SUI: 3 };
const leg = (over: Partial<AttestPosition> = {}): AttestPosition => ({
  symbol: 'BTC', side: 'LONG', entryPrice: 100_200, notionalUsd: 300, marginUsd: 100, leverage: 3, signalConfidence: 62, ...over,
});

describe('basketProblem', () => {
  it('passes a basket at current prices', () => {
    expect(basketProblem([leg(), leg({ symbol: 'ETH', side: 'SHORT', entryPrice: 3_990 })], 1_000, live)).toBeNull();
  });

  it('refuses a price that is not the current one', () => {
    expect(basketProblem([leg({ entryPrice: 50_000 })], 1_000, live)).toMatch(/not the current price/);
  });

  it('refuses unknown symbols, repeats, bad sides, bad numbers and wild leverage', () => {
    expect(basketProblem([leg({ symbol: 'DOGE' })], 1_000, live)).toMatch(/unknown symbol/);
    expect(basketProblem([leg(), leg()], 1_000, live)).toMatch(/twice/);
    expect(basketProblem([leg({ side: 'HOLD' })], 1_000, live)).toMatch(/side/);
    expect(basketProblem([leg({ notionalUsd: -5 })], 1_000, live)).toMatch(/positive/);
    expect(basketProblem([leg({ leverage: 500 })], 1_000, live)).toMatch(/leverage/);
    expect(basketProblem([leg({ signalConfidence: 900 })], 1_000, live)).toMatch(/signalConfidence/);
    expect(basketProblem([leg()], 0, live)).toMatch(/poolNavUsd/);
    expect(basketProblem([], 1_000, live)).toMatch(/positions/);
  });

  it('with no server price it refuses rather than trusting the browser', () => {
    expect(basketProblem([leg()], 1_000, {})).toMatch(/no server price/);
  });

  it('the route checks the basket and claims the shared slot before it submits', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../app/api/hedera/attest-hedges/route.ts'), 'utf8');
    const check = src.indexOf('basketProblem(positions, nav, livePrice)');
    const claim = src.indexOf("tryClaimCronRun('hedera-attest-hedges'");
    const submit = src.indexOf('new TopicMessageSubmitTransaction()');
    expect(check).toBeGreaterThan(0);
    expect(claim).toBeGreaterThan(check);
    expect(submit).toBeGreaterThan(claim);
  });
});
