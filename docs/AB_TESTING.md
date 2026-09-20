# A/B strategy testing (L12)

Two paper traders side by side. Same signal aggregator, same market data,
different entry filters or exit tuning. After N trades, the comparison
report shows which strategy actually made more money.

## What the code already gives you

- `GET /api/admin/strategy-ab?a=-3&b=-4&window=7` — head-to-head report.
- Portfolio IDs are the router: portfolio_id -3 (default) is prod paper
  ("strategy A"). Any other integer becomes strategy B / C / D.
- All tuning knobs are env vars (leverage, stops, majority %, etc.), so
  variants are one prefix apart.

## Running strategy B

The trader itself doesn't yet route ticks between portfolio IDs — that's
a small refactor in `PaperTrader.runTick` to accept a `portfolioId` arg
plus a paired variant of the config-reading modules (bandit, decay,
etc.) so their cron_state keys don't collide.

Path 1 — quick and dirty (recommended for one-off experiments)
- Set variant env vars (e.g. `PAPER_TRADER_B_LEVERAGE=2`).
- Wrap `PaperTrader.runTick` in a coin-flip: 90 % of the time run
  with `PORTFOLIO_ID=-3` env (default), 10 % with `PORTFOLIO_ID=-4`
  and the B-prefixed knobs applied via a mini config-override.
- Requires wiring `PAPER_PORTFOLIO_ID` to be per-invocation instead of
  module-level constant. ~30 min of surgery.

Path 2 — proper (recommended before shipping A/B to live capital)
- Extract per-strategy state (bandit arms, decay overrides, source
  calibrator buckets) to per-portfolio-id keys.
- Add a `StrategyDefinition` type — {portfolioId, envPrefix, filters}.
- `runTickForStrategy(strategy, now)` clone the current runTick with
  strategy-scoped state. Alternate strategies on tick round-robin
  or by hash of `now`.
- 2-3 hours of engineering.

## What variants make sense to try

Once path 1 or 2 is wired, sensible first experiments:
- **B = higher exploration**: `PAPER_TRADER_BANDIT_EXPLORATION_C=2.5`.
  Tests whether current 1.4 is too greedy on cold-start arms.
- **B = wider stops**: `PAPER_TRADER_ADAPTIVE_STOP_MULT=2` (default 1.2).
  Tests whether we're cutting winners short in high vol.
- **B = tighter majority filter**: `PAPER_TRADER_MIN_MAJORITY_PCT=0.7`.
  Tests whether the current 60% agreement threshold is too loose.

Only run one variant change at a time — orthogonal changes make the
verdict ambiguous.

## Statistical sanity

Head-to-head stats become meaningful around 30 trades per side. Below
that, single-lucky-trade noise dominates. Don't call a winner on 5
trades.

The `sharpeLite` metric in the report is `mean_pnl / stddev_pnl` —
directly comparable across strategies without annualisation. Higher is
better.

## Kill switch

If strategy B under-performs by more than 2x A over the last 7 days,
demote it (revert env vars, drop the cron_state override).
