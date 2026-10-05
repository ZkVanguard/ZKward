/**
 * The named list of entry gates is what the ledger measures. A rule the book
 * applies that is missing from the list is a rule nobody measures, which is
 * how a gate kept a book on one side of the market for three days unseen.
 */
import { describe, it, expect, jest } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

jest.mock('@/lib/db/cron-state', () => ({ getCronState: jest.fn(async () => null), getCronStateOr: jest.fn(async (_k: string, d: unknown) => d), setCronState: jest.fn(async () => undefined) }));
jest.mock('@/lib/db/postgres', () => ({ query: jest.fn(async () => []) }));

import { ENTRY_GATES, gateRefusals, type EntryGate, type GateSetting, type GateSignal } from '@/lib/services/paper-trader/entry-gates';

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf8');
const SETTING: GateSetting = { now: 1_790_000_000_000, nav: 100_000, minConfidence: 70, regime: null };
const signal = (over: Partial<GateSignal['prediction']> = {}): GateSignal => ({
  asset: 'BTC',
  direction: 'UP',
  prediction: { confidence: 80, consensus: 75, recommendation: 'HEDGE_LONG', sources: [{ direction: 'UP' }, { direction: 'UP' }, { direction: 'UP' }, { direction: 'DOWN' }] as GateSignal['prediction']['sources'], ...over },
});
const only = (name: string) => ENTRY_GATES.filter((g) => g.name === name);

describe('the gate list covers the book', () => {
  it('every refusal function the book calls is in the list', () => {
    const book = read('lib/services/paper-trader/PaperTrader.ts') + read('lib/services/paper-trader/entry-helpers.ts');
    const list = read('lib/services/paper-trader/entry-gates.ts');
    const called = new Set([...book.matchAll(/\b([A-Za-z]+Rejection)\s*\(/g)].map((m) => m[1]));
    // signalQualityRejection is its two halves here (majority, stability), so each is measured alone.
    called.delete('signalQualityRejection');
    expect(called.size).toBeGreaterThan(3);
    for (const fn of called) expect(list).toContain(fn);
    expect(list).toContain('majorityAgreementPct');
    expect(list).toContain('isSignalStable');
  });

  it('gate names are unique', () => {
    const names = ENTRY_GATES.map((g) => g.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('the threshold gates', () => {
  it('refuse below the floor and not at it', async () => {
    expect(await gateRefusals(signal({ confidence: 69.9 }), SETTING, only('min-confidence'))).toEqual(['min-confidence']);
    expect(await gateRefusals(signal({ confidence: 70 }), SETTING, only('min-confidence'))).toEqual([]);
    expect(await gateRefusals(signal({ confidence: 72 }), { ...SETTING, minConfidence: 73.5 }, only('min-confidence'))).toEqual(['min-confidence']);
    expect(await gateRefusals(signal({ consensus: 10 }), SETTING, only('min-consensus'))).toEqual(['min-consensus']);
    expect(await gateRefusals(signal({ sources: [] }), SETTING, only('min-sources'))).toEqual(['min-sources']);
  });

  it('majority counts the sources that agree with the signal', async () => {
    const split = [{ direction: 'UP' }, { direction: 'DOWN' }, { direction: 'DOWN' }, { direction: 'DOWN' }] as GateSignal['prediction']['sources'];
    expect(await gateRefusals(signal({ sources: split }), SETTING, only('majority'))).toEqual(['majority']);
    expect(await gateRefusals(signal(), SETTING, only('majority'))).toEqual([]);
  });

  it('chop follows the regime', async () => {
    expect(await gateRefusals(signal(), { ...SETTING, regime: 'CHOP' }, only('chop'))).toEqual(['chop']);
    expect(await gateRefusals(signal(), { ...SETTING, regime: 'TRENDING_UP' }, only('chop'))).toEqual([]);
  });
});

describe('gateRefusals', () => {
  const gate = (name: string, refuses: EntryGate['refuses']): EntryGate => ({ name, refuses });

  it('names the gates that refuse, sync or async, in list order', async () => {
    const gates = [gate('a', () => true), gate('b', async () => false), gate('c', async () => true)];
    expect(await gateRefusals(signal(), SETTING, gates)).toEqual(['a', 'c']);
  });

  it('a gate whose check fails does not refuse, like the book', async () => {
    const gates = [gate('broken', async () => { throw new Error('db down'); }), gate('ok', () => true)];
    expect(await gateRefusals(signal(), SETTING, gates)).toEqual(['ok']);
  });
});
