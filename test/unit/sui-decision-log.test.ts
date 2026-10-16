/**
 * The pool's decision log says what ran. A paused pool logged 170 REBALANCE
 * rows a day with no swap, and the dashboard read `executed` from a field no
 * one wrote.
 */
import { describe, it, expect, jest } from '@jest/globals';

const rows: Array<{ details: Record<string, unknown> }> = [];
jest.mock('@/lib/db/community-pool', () => ({
  addPoolTransactionToDb: jest.fn(async (r: { details: Record<string, unknown> }) => { rows.push(r); }),
}));
jest.mock('@/lib/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { runStep9LogDecision, type Step9Input } from '@/lib/services/sui/cron/step-9-log-decision';

const input = (over: Partial<Step9Input>): Step9Input => ({
  navUsd: 20, sharePriceUsd: 0.04, poolStats: { memberCount: 3 } as Step9Input['poolStats'], pricesUSD: {},
  aiResult: { shouldRebalance: true, allocations: {}, confidence: 0.6, reasoning: 'r' } as unknown as Step9Input['aiResult'],
  enhancedContext: {}, rebalanceSwaps: undefined, swapsExecuted: 0, ...over,
});

describe('decision log', () => {
  it('a proposed rebalance with no swap is a HOLD that was not executed', async () => {
    await runStep9LogDecision(input({ swapsExecuted: 0 }));
    expect(rows.pop()?.details).toMatchObject({ action: 'HOLD', executed: false, proposed: 'REBALANCE' });
  });

  it('a rebalance with an executed swap says so', async () => {
    await runStep9LogDecision(input({ swapsExecuted: 2 }));
    expect(rows.pop()?.details).toMatchObject({ action: 'REBALANCE', executed: true, proposed: 'REBALANCE' });
  });
});
