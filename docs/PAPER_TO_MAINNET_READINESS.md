# Paper trader → mainnet promotion criteria

**Purpose.** Turn "the paper trader must make money before we go mainnet" from vibes into a numeric bar. Every criterion below has a SQL query that returns the current value against Bakchodi. Promote only when **all** are green in the same 4-week window.

**Why 4 weeks.** Two full cycles of the 30-day cron_state windows the trader already uses (regret sampling, source calibration). Shorter windows produce noise; longer windows delay real signal.

## The gates (all must pass)

| # | Metric | Bar | SQL / where to look |
|---|---|---|---|
| 1 | **Realized PnL, last 28d** | `> 0` and slope non-negative week-over-week | `SELECT SUM(current_pnl) FROM hedges WHERE simulation_mode=true AND status='closed' AND closed_at >= NOW() - INTERVAL '28 days'` |
| 2 | **Trade count, last 28d** | `>= 100` closed trades (else no statistical significance) | Same query, `COUNT(*)` |
| 3 | **Win rate, last 28d** | `>= 35%` (vs Sept 15-19 baseline of 26%) | `COUNT(*) FILTER (WHERE current_pnl > 0) * 100.0 / COUNT(*)` |
| 4 | **Profit factor, last 28d** | `>= 1.4` — sum(wins) / |sum(losses)| ≥ 1.4 | `SUM(current_pnl) FILTER (WHERE current_pnl > 0) / ABS(SUM(current_pnl) FILTER (WHERE current_pnl < 0))` |
| 5 | **Max daily drawdown, last 28d** | `<= 3%` of daily-peak NAV — no single day loses > 3% | Read `paper-trader:nav-series` (500-point rolling), compute daily peak-to-trough |
| 6 | **Max weekly drawdown, last 28d** | `<= 6%` of weekly-peak NAV | Same source, weekly resample |
| 7 | **Stop-loss trigger rate** | `>= 30%` of losing trades close via price-anchored stop (proves the stop is active, not just the max-hold cushion) | `COUNT(*) FILTER (reason ILIKE '%stop-loss%') * 100.0 / COUNT(*) FILTER (current_pnl < 0)` |
| 8 | **Max-hold trigger rate** | `<= 40%` of losing trades close on max-hold (was 84% Sept 15-19) | `COUNT(*) FILTER (reason ILIKE '%max-hold%') * 100.0 / COUNT(*) FILTER (current_pnl < 0)` |
| 9 | **No consecutive-loss halts, last 14d** | `paper-trader:stats.haltedUntilMs == 0` at every daily check | `SELECT value FROM cron_state WHERE key = 'paper-trader:stats'` — check `haltedUntilMs` across daily snapshots |
| 10 | **Source calibration: at least 3 sources with per-source hit rate > 55%** | Aggregator has provable edge on real outcomes | `source_outcomes` table aggregation over 28d |

## What promotion actually looks like

**If all 10 gates green for two consecutive weeks:**
1. Freeze the paper config (env vars snapshotted, git-tagged as `paper-mainnet-candidate-vN`).
2. Flip a **shadow-live** phase: same config, tiny real capital ($100-500), 2 weeks. Confirms venue-side friction (BlueFin fee/funding/slippage) matches the simulated executor's model.
3. If shadow-live PnL is within ±20% of concurrent paper PnL, promote.
4. Ramp real capital 10× per week (500 → 5K → 50K → 500K), pausing at each rung if any gate re-fails.

## What causes a demotion (rollback trigger)

Any of the following flips the trader off:
- Realized PnL over any 7-day window `< -2%` of NAV
- Two red gates simultaneously
- The bulletproof drawdown test (`bun jest test/integration/pool-drawdown-defense.test.ts`) fails
- The `paper-trader:stats.haltedUntilMs` non-zero at any hourly check

## Where the numbers live

- **Trade rows:** `hedges` on Bakchodi (`simulation_mode = true`)
- **NAV series:** `cron_state.paper-trader:nav-series` (500-point ring, 5-min cadence)
- **Trader stats:** `cron_state.paper-trader:stats` (`{ trades, wins, losses, cumRealizedUsd, haltedUntilMs, ... }`)
- **Source calibration:** `source_outcomes` table
- **The gate script (to be written):** `scripts/check-paper-mainnet-readiness.ts` — outputs 10 rows, green/red per gate. Run daily; page if any goes red.

## Not on the list

Deliberately excluded to keep the bar objective:
- **Sharpe ratio** — needs risk-free rate + return periodization assumptions this small sample can't support
- **AI confidence calibration** — proxy'd by gate 10 (per-source hit rate)
- **Any comparison to buy-and-hold** — trader is directional not passive; benchmark is 0, not BTC

## Current state (2026-09-20 baseline)

Every gate is currently red or unmeasurable — that's the whole point of writing them down. Post-mortem note is at [`memory/project_paper_trader_forensics_2026_09_20.md`](../memory/project_paper_trader_forensics_2026_09_20.md).

| Gate | Now | Target | Δ |
|---|---|---|---|
| 1 realized PnL 28d | -$68,000 | > 0 | + $68K + |
| 2 trade count 28d | 164 | ≥ 100 | ✅ |
| 3 win rate 28d | 26.2% | ≥ 35% | +8.8 pt |
| 4 profit factor | ~0.3 (est.) | ≥ 1.4 | 4.7× |
| 5 max daily DD | ~5.8% (Sept 16) | ≤ 3% | -2.8 pt |
| 7 stop-loss trigger rate | 0% | ≥ 30% | fix just shipped |
| 8 max-hold trigger rate | 84% | ≤ 40% | fix just shipped |
| 9 no halts 14d | ✅ (haltedUntilMs = 0) | ✅ | ✅ |

Realistic path: the just-shipped price-anchored stop + 45m max-hold fix should move gates 7, 8, and materially help 1, 3, 4, 5 within 2-4 weeks of continued paper trading. Gate 10 (source calibration) is a longer research arc — needs `source_outcomes` accumulation and possibly a source-weight refit.
