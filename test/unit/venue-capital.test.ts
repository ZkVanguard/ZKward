/**
 * Every move of capital to the venue is recorded once, by its transaction, so
 * the account can be explained from rows.
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

const query = jest.fn(async (_sql: string, _p?: unknown[]) => [] as unknown[]);
jest.mock('@/lib/db/postgres', () => ({ query: (sql: string, p?: unknown[]) => query(sql, p) }));

import { recordVenueCapital } from '@/lib/db/venue-capital';

beforeEach(() => query.mockClear());

describe('recordVenueCapital', () => {
  it('writes one row per transaction digest', async () => {
    await recordVenueCapital('deposit', 5, '0xdigest');
    const insert = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO venue_capital'));
    expect(insert?.[0]).toContain('ON CONFLICT (tx_digest) DO NOTHING');
    expect(insert?.[1]).toEqual(['deposit', 5, '0xdigest', null]);
  });

  it('refuses a move with no amount or no digest instead of writing a row that explains nothing', async () => {
    await expect(recordVenueCapital('deposit', 0, '0xdigest')).rejects.toThrow();
    await expect(recordVenueCapital('deposit', 5, '')).rejects.toThrow();
  });

  it('the one venue deposit path records each deposit that landed', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../lib/services/sui/BluefinTreasuryService.ts'), 'utf8');
    expect(src).toMatch(/if \(ok\) \{[\s\S]{0,200}recordVenueCapital\('deposit', amount, txDigest\)/);
  });
});
