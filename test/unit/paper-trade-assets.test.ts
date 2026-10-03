/**
 * The books open positions only on the trade list, while the ledger and live
 * signals keep the whole universe (backtest in the config comment).
 */
const load = (env: Record<string, string | undefined>) => {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  for (const k of Object.keys(env)) if (env[k] === undefined) delete process.env[k];
  let cfg: typeof import('@/lib/services/paper-trader/config') | undefined;
  jest.isolateModules(() => { cfg = require('@/lib/services/paper-trader/config'); });
  process.env = saved;
  return cfg!;
};

describe('paper trade assets', () => {
  it('trades BTC and ETH by default and keeps the full universe for signals', () => {
    const c = load({ PAPER_TRADER_TRADE_ASSETS: undefined, PAPER_TRADER_ASSETS: undefined });
    expect(c.PAPER_TRADE_ASSETS).toEqual(['BTC', 'ETH']);
    expect(c.PAPER_UNIVERSE).toEqual(['BTC', 'ETH', 'SOL', 'XRP', 'DOGE']);
  });

  it('an override can only name assets the universe covers', () => {
    const c = load({ PAPER_TRADER_TRADE_ASSETS: ' btc, sol ,ADA\r\n', PAPER_TRADER_ASSETS: undefined });
    expect(c.PAPER_TRADE_ASSETS).toEqual(['BTC', 'SOL']);
  });

  it('the entry scan reads the trade list, not the universe', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../../lib/services/paper-trader/entry-helpers.ts'), 'utf8');
    expect(src).toMatch(/scanAndPickBest\(PAPER_TRADE_ASSETS,/);
    expect(src).not.toMatch(/PAPER_UNIVERSE/);
  });
});
