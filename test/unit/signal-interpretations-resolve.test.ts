/**
 * resolveDirectional scores the market-implied direction; a market that
 * forecast no move records its exit price and stays unscored (and out of
 * the postmortem set — outcome_linked_at untouched).
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const mockQuery = jest.fn(async (..._args: unknown[]) => [] as unknown[]);
jest.mock('@/lib/db/postgres', () => ({ query: (...args: unknown[]) => mockQuery(...args) }));

import { resolveDirectional } from '@/lib/db/signal-interpretations';

const updateParams = () => {
  const call = mockQuery.mock.calls.find(([sql]) => String(sql).includes('UPDATE signal_interpretations'));
  return call?.[1] as unknown[];
};

beforeEach(() => mockQuery.mockClear());

describe('resolveDirectional', () => {
  it('scores the implied direction against the move', async () => {
    expect(await resolveDirectional('s', 'UP', 84_000, 85_000)).toEqual({ correct: true, signedDelta: 1_000 });
    expect(updateParams()).toEqual([85_000, true, 1_000, 's']);
    mockQuery.mockClear();
    expect(await resolveDirectional('s', 'DOWN', 84_000, 85_000)).toEqual({ correct: false, signedDelta: -1_000 });
  });

  it('no forecast → exit price only, unscored', async () => {
    expect(await resolveDirectional('s', null, 84_000, 85_000)).toEqual({ correct: null, signedDelta: null });
    expect(updateParams()).toEqual([85_000, null, null, 's']);
  });
});
