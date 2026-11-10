/**
 * Every money figure in an answer must come from the data the model was
 * handed; a figure that does not is reported, never passed.
 */
import { describe, it, expect } from '@jest/globals';
import { verifyFigures, extractFigures } from '@/lib/services/ai/verify-figures';

const books = [
  { name: 'PaperTrader', closed: { trades: 84, wins: 68, realizedUsd: -202, avgBp: -19.2103 }, open: { positions: 0, notionalUsd: 0, openPnlUsd: 0 } },
  { name: 'FloorTrader', closed: { trades: 7, wins: 0, realizedUsd: -480.79, avgBp: -686.84 }, open: { positions: 24, notionalUsd: 24000, openPnlUsd: -1871.08 } },
  { name: 'FloorLadderTrader', closed: { trades: 101, wins: 59, realizedUsd: -1383.97, avgBp: -137.03 }, open: { positions: 18, notionalUsd: 18000, openPnlUsd: -471.07 } },
];
const pools = [{ pool: 'SUI USDC pool', money: 'real USDC, deposits capped at $10K by the contract', now: { sharePrice: 0.2724, navUsd: 20.18, members: 3 }, membersPaidInUsd: 60.8 }];
const sources = [
  { label: 'question', data: 'Promise me 20% a year' },
  { label: 'get_paper_books', data: books },
  { label: 'get_pools', data: pools },
];

describe('verifyFigures', () => {
  it('passes figures from the rows at the rounding the answer shows', () => {
    const answer = 'FloorTrader: -$480.79 realized (-687bp), 24 open ($24k) at -$1,871.08, about -$1.9k. PaperTrader -$202, -19bp.';
    const r = verifyFigures(answer, sources);
    expect(r.unverified).toEqual([]);
    expect(r.verified.find((f) => f.text === '$1,871.08')?.source).toBe('get_paper_books › FloorTrader › open › openPnlUsd');
  });

  it('passes totals across books and gaps and changes inside one record', () => {
    const r = verifyFigures('Together -$2,066.76 realized. The pool is $20.18 against $60.80 paid in: $40.62 below cost, down 67%. Deposits capped at $10K.', sources);
    expect(r.unverified).toEqual([]);
    expect(r.verified.find((f) => f.text === '$40.62')?.source).toMatch(/^gap between/);
  });

  it('reads the desk trading cost as bp, not as a percentage', () => {
    const desk = [{ label: 'get_research_desk', data: { rulesTried: 1840, costPerChangeBp: 10, barEdgeT: 3.88 } }];
    expect(verifyFigures('Tested net of 10bp per change.', desk).unverified).toEqual([]);
  });

  it('reports a figure that is in no source', () => {
    const r = verifyFigures('FloorTrader made $5,000 last month, a 12% return.', sources);
    expect(r.unverified.map((f) => f.text)).toEqual(['$5,000', '12%']);
  });

  it('checks a percentage the user said against the question', () => {
    expect(verifyFigures('I cannot promise 20% a year.', sources).unverified).toEqual([]);
  });

  it('credits a figure to a field of its unit before a number in prose, and to the closest value', () => {
    const withDate = [...sources, { label: 'get_paper_books', data: [{ name: 'Oracle', tests: 'switched off since 2026-10-19' }] }];
    const r = verifyFigures('PaperTrader averaged -19bp.', withDate);
    expect(r.verified[0].source).toBe('get_paper_books › PaperTrader › closed › avgBp');
    expect(verifyFigures('$0 in costs', [{ label: 't', data: { sharePrice: 0.27, opsUsd: 0 } }]).verified[0].source).toBe('t › opsUsd');
  });

  it('does not let a count stand in for money', () => {
    expect(verifyFigures('That is $84.', sources).unverified.map((f) => f.text)).toEqual(['$84']);
  });

  it('ignores bare numbers and reads k and bp forms', () => {
    expect(extractFigures('84 trades in 2026, $24k, -19.2 bp, 3.5%').map((f) => [f.unit, f.value])).toEqual([
      ['usd', 24000], ['bp', 19.2], ['pct', 3.5],
    ]);
  });
});
