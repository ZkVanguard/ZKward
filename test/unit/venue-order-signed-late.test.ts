/**
 * The venue refuses an order signed more than a minute before it arrives. Both
 * order paths therefore do their reads first and send right after signing:
 * nothing awaited may sit between the signature and the order request.
 */
import { describe, it, expect } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

describe.each([
  'lib/services/sui/bluefin/open-hedge-impl.ts',
  'lib/services/sui/bluefin/close-hedge-impl.ts',
])('%s', (file) => {
  const src = fs.readFileSync(path.resolve(__dirname, '../..', file), 'utf8');

  it('reads the account before it signs', () => {
    expect(src.indexOf('await readAccountSnapshot(ctx)')).toBeLessThan(src.indexOf('await ctx.signOrder(signedFields)'));
  });

  it('sends the order with no other await between signing and sending', () => {
    const signed = src.indexOf('await ctx.signOrder(signedFields)');
    const sent = src.indexOf("'POST', '/api/v1/trade/orders'");
    const between = src.slice(signed + 'await ctx.signOrder(signedFields)'.length, sent);
    expect(between.match(/await /g)).toEqual(['await ']);
    expect(between).toMatch(/await ctx\.apiRequest</);
  });
});

describe('a close follows the position margin mode', () => {
  it('the parser carries the venue isIsolated flag, and absent means isolated', async () => {
    const { parseAccountPosition } = await import('@/lib/services/sui/bluefin-ticker-parsers');
    const base = { symbol: 'ETH-PERP', side: 'SHORT', sizeE9: '10000000', leverageE9: '3000000000' };
    expect(parseAccountPosition({ ...base, isIsolated: false }).isIsolated).toBe(false);
    expect(parseAccountPosition({ ...base, isIsolated: true }).isIsolated).toBe(true);
    expect(parseAccountPosition(base).isIsolated).toBe(true);
  });

  it('the close signs in the position mode', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../lib/services/sui/bluefin/close-hedge-impl.ts'), 'utf8');
    expect(src).toContain('isIsolated: position.isIsolated !== false,');
  });
});
