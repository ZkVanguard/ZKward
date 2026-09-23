# Paper Trader — Horizon Alignment Fix Plan

**Date:** 2026-09-23
**Status:** Planned, not yet implemented

## Problem statement

Paper trader win rate is stuck at ~39% over 64 closes despite AI interpretations having 81.3% accuracy on 48 resolved outcomes. Investigation revealed a fundamental **horizon mismatch** and **signal-dilution** problem:

| Layer | Actual accuracy | Weight in aggregate | Timeframe |
|---|---|---|---|
| AI interpretations (fine-tuned Qwen) | **81.3%** | ~5% per source × 4 = 20% max | 4-255 hours |
| Prediction markets (Polymarket/Delphi/Manifold/Kalshi) | 50-53% median | ~10-15% per source × 15+ = 60-75% | Variable |
| Paper trader avg hold | — | — | **26 minutes** |
| Paper trader max hold | — | — | **89 minutes** |

**AI is right, at multi-day horizons, but paper trades 30-min windows.** By the time the AI's 81%-accurate directional call plays out, the paper trade has already closed via signal-flip or max-hold.

## Per-market AI accuracy (from source-calibrator)

Some AI signals have very real edge; others are worse than random:

| Market | Obs | Hit % |
|---|---|---|
| ai-will-bitcoin-be-above-84K | 9 | **88.9%** |
| ai-will-ethereum-dip-to-2000 | 9 | 77.8% |
| ai-will-ethereum-dip-to-1500 | 10 | 70.0% |
| ai-will-eth-above-2K (medium horizon) | 7 | 28.6% |
| ai-will-ethereum-reach-3300-Sept | 9 | 22.2% |

The 81% aggregate hides real variance. Source-calibrator already boosts good ones and kills bad ones — but capped at 5% base weight, they can't swing the aggregate.

## Root causes ranked by fixability

1. **AI weight is too low** (`0.05 × confidence × novelty` per source) — fixable in one config line.
2. **AI horizon filtering doesn't exist** — all AI signals go into the pool regardless of horizon. Multi-week `monthly` signals feed a 30-min trader.
3. **Paper hold window is too short** for AI's dominant horizon (4-day avg) — bigger change, needs live measurement.

## Fix plan — 3 phases

### Phase 1 — Boost AI weight + filter by horizon (SAFE)

Two changes in `PredictionAggregatorService.ts` where AI sources are pushed:

**A. Filter by horizon** — include only signals matching paper's operational window:
```typescript
// Skip AI signals with horizon > 24h — paper closes in ~30-90 min so
// multi-day predictions don't inform the tick decision. Keep 'hourly',
// 'daily', and 'unknown' (default assumption). Drop 'monthly' explicitly.
const usableHorizons = new Set(['hourly', 'daily', 'unknown']);
const filteredAi = aiForAsset.filter((interp) =>
  !interp.horizon || usableHorizons.has(interp.horizon)
);
```

**B. Boost weight base** 0.05 → 0.15:
```typescript
// Was 0.05 base — capped AI at 5% weight per source (max 20% total).
// AI has 81% empirical accuracy vs 50-53% median for prediction markets;
// give it 3× the weight so calibrator-boosted good sources actually
// swing the aggregate. Bad sources still get calibrator-killed at
// <40% hit rate (PR #233).
const w = 0.15 * interp.confidence * (0.5 + interp.novelty * 0.5);
```

**Expected effect:** AI sources with 77-88% hit rate will pull aggregate direction meaningfully. Weight-per-source becomes 3-15% depending on confidence + novelty, competitive with prediction markets at 10-15%.

**Risk:** Bad AI sources (22-28% hit rate) will pull the OTHER way with 3× more force. Source-calibrator's KILL cutoff (mult=0.05 at <40% hit rate) should neutralize them, but not until 15+ observations accumulate.

**Mitigation:** Ship + measure for 24h. If win rate degrades, revert immediately (single env-var toggle).

### Phase 2 — Extend max-hold to match AI's dominant horizon (MEDIUM)

Currently `PAPER_MAX_HOLD_MIN = 45` in prod. AI's dominant horizon is "daily" at 4h avg. Extending max-hold lets AI-driven positions have time to play out.

**Change:** `PAPER_TRADER_MAX_HOLD_MIN = 240` (4 hours) — but only via env var, keep code default at 45 for safety.

**Regime multipliers still apply:** CHOP × 0.75 = 180min, TREND × 1.5 = 360min.

**Signal-flip and stop-loss still fire earlier** — max-hold is the CEILING, not a fixed hold time. Winners will still close via trailing-stop; losers via price-anchored stop.

**Expected effect:** trades that currently hit max-hold at 45min (15 this session, -$76 net) will hold longer. If AI is right, they turn into winners; if wrong, they lose more.

**Risk:** In current CHOP regime, longer holds ate positions before. Backtest showed max-hold expiries at 20-25min had 16.7% win rate — extending might help OR hurt.

**Mitigation:** env-var only — Vercel toggle without redeploy. Watch for 6-12h then decide.

### Phase 3 — Weight sources by horizon-match (AGGRESSIVE, deferred)

Later: dynamically weight each source based on how well its horizon matches the current tick's expected hold. Requires per-source horizon metadata for prediction markets too. Bigger refactor.

## Execution order

1. Write plan (this file) ✓
2. Add todos with `TaskCreate`
3. Implement Phase 1 in one PR (both changes are ~10 LOC)
4. Deploy and measure 6-12h
5. If Phase 1 positive → Phase 2 as env-var toggle
6. If Phase 2 positive → productize; else revert

## Success metrics

- **Immediate (Phase 1)**: win rate lifts above 45% in the 24h after deploy
- **Medium (Phase 2)**: win rate above 50% at extended hold window
- **Long-term**: trader is Sharpe-positive over 500+ trades

## Rollback triggers

- Any single tick fires >3 halts in an hour → revert immediately
- Win rate drops below 30% for 2 consecutive hours → revert
- Any silent failure in aggregator (no sources returned) → revert
