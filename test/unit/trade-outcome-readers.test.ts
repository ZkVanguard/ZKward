/**
 * A pool row closed by the reconciler, or re-adopted from the venue, holds a
 * mark, not a trade result. Every reader that counts wins, losses or P&L from
 * closed rows filters them out with the one shared condition.
 */
import { describe, it, expect } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

const root = path.resolve(__dirname, '../..');
const src = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('trade outcome readers', () => {
  it.each([
    'lib/db/agent-decisions.ts',
    'app/api/platform/risk-overview/route.ts',
    'app/api/dashboard/autonomy-status/route.ts',
    'app/api/cron/polymarket-edge-trader/handlers/regret-gate.ts',
    'app/api/admin/strategy-pnl/route.ts',
    'scripts/analyze-pool-pnl.ts',
  ])('%s filters with TRADE_OUTCOME_SQL', (file) => {
    expect(src(file)).toMatch(/\$\{TRADE_OUTCOME_SQL\}/);
  });

  it('the agent scorecard reads outcomes from the hedge rows, not from a column nothing writes', () => {
    const s = src('lib/db/agent-decisions.ts');
    expect(s).toContain('LEFT JOIN (');
    expect(s).not.toContain('settleAgentDecision');
    expect(s).toContain('winRate: settled > 0 ? wins / settled : null');
  });

  it('the live trader records its row id with the decision, so the scorecard can join it', () => {
    const s = src('app/api/cron/polymarket-edge-trader/route.ts');
    const call = s.slice(s.indexOf('await completeTrade(guard, {'), s.indexOf('await completeTrade(guard, {') + 400);
    expect(call).toContain('orderId: clientOrderId,');
    expect(s).toMatch(/createHedge\(\{\s*orderId: clientOrderId,/);
  });
});
