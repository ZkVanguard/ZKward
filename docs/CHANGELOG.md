# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.2] - 2026-09-21 — Prediction aggregator overhaul + HedgingAgent integration

Paper-trader forensics from 2026-09-20 identified −$68K on 163 trades at 26.4% win rate. The audit traced the root cause: ~40% of "prediction market" signal weight was actually technical/momentum indicators (Crypto.com 24h + funding), and the primary Polymarket source was a 5-min binary market (coin-flip horizon at that resolution). Meanwhile 995 LOC of built-out prediction market services sat unwired.

### Aggregator — wire what was already built (PRs #193 #194 #195 #196)

- **`PolymarketBroadMarketsService`** (379 LOC) — hourly/daily/weekly binary + price-target markets. Was fetching + classifying by `horizonHours` with no consumer. Now wired into `getPerAssetPredictions`: top 3 by 24h volume per asset, weight 0.06/0.05/0.04, horizon-filtered to hourly + daily (matches paper-trader 45min hold).
- **`PolymarketMomentumService`** (289 LOC) — computes hotness from probability velocity + volume ratio + liquidity change on the broad markets' history ring buffer. Wired as a per-market weight multiplier: `weight × (1 + min(0.5, hotness/200))` — hot markets get up to 1.5× boost.
- **`detectThemes()`** — clusters broad markets by keyword theme (`etf-approval`, `fed-rates`, `regulation`, `halving`, etc.). Themes with ≥3 markets and volume-weighted directional consensus ≥ 0.3 become synthetic `PredictionSource` entries scoped by the theme's `affectsAssets` list.
- **AI signal interpretations** — the fine-tuned Signal Interpreter in `poly-discover-tick` extracts `{asset, direction, horizon, confidence, novelty}` per new broad market. Prod stats: **29 resolved outcomes, 24 correct → 82.8% accuracy**, avg confidence 0.87. Wired via `signal_interpretations` DB query in the aggregator, top 4 per asset ordered by `(confidence × novelty)`. Filter had a bug initially — required `horizon IN ('hourly','daily')` but the interpreter tags most as `unknown` (31 BTC UPs at unknown vs 3 at daily). Fixed to `horizon NOT IN ('weekly','monthly')`.
- **Crypto.com 24h weight** dropped 0.20 → 0.10. Source calibrator confirmed n=39, 51.0% hit rate = coin flip. Was contributing ~20% of total signal weight to noise.
- **Legacy BTC ticker** kept at 0.10 — calibrator says it's the best-performing base source (n=75, 56.5% hit rate).
- **Delphi keyword tagging** extended from BTC/ETH-only to also tag `SOL / XRP / DOGE / SUI` markets. Word-boundary regex on 3-letter tickers to avoid false positives (`\bsol\b`, `\bxrp\b`, etc.).
- **Kalshi resolved-market filter** — direct API check at 12:57 UTC-4 found `KXBTCD` returning 5 markets all at 0.00/0.01 yes-price (hourly bracket resolved 3 min prior but still `status='active'`). Trusting them produced spurious `direction=DOWN` on BTC because stale $89K strikes were far below $113K spot. Fix: filter yes-price outside `[0.02, 0.98]` before ATM search — next hourly bracket is typically in the same 100-market payload.
- **`poly-discover` cadence 30min → 5min** — added to master cron fanout list (`app/api/cron/master/route.ts`). Route has no `tryClaimCronRun` gate so 5-min pings mean 5-min runs. Gives the 82.8%-accurate interpreter 6× more opportunities per hour to label new markets. Sui-community-pool piggyback kept for redundancy; DB writes are idempotent.
- **`poly-discover-tick` momentum slot 75 → 200** (env-tunable via `POLY_MOMENTUM_TOP_N`). Audit found 3,920 of 6,551 tracked slugs had exactly 1 snapshot because they rotated out of the top-75 after first tick. 200 keeps history alive for the volume tail. Post-deploy: slugs with ≥5 samples jumped 18 → 59 (3.3× improvement).

### HedgingAgent → PredictionAggregatorService (PR #197)

The integration gap that made the aggregator work only half-effective: `HedgingAgent` (called via `agent-orchestrator.publishDirectivesAndAttest`) **overrode** the aggregator-seeded per-asset directive with a partial-data opinion — it only imported `DelphiMarketService` + `Polymarket5MinService`, missing everything else.

- New helper `getAggregatorSignal(asset)` — 20s-cached wrapper, null on failure.
- `analyzeHedgeOpportunity` — consults aggregator, boosts `hedgeRatio` on STRONG_HEDGE_* / HEDGE_* by `confidence × consensus`, adds aggregator recommendation as first-class `shouldHedge` trigger. Delphi path preserved as fail-open fallback.
- `voteOnExecution` — adds `aggregatorPenalty` combining direction alignment + confidence + rec strength. Legacy signal + Delphi penalties fire ONLY when aggregator missed (no double-count of Delphi).
- Accepts optional `asset` + `proposedSide` in proposal (LeadAgent's `votingProposal` doesn't currently pass these — strategic intents are asset-agnostic; per-asset votes flow through `agent-trade-guard.castAutomatedConsensusVotes` which reads the rich directives instead).

### Pre-existing test failures fixed (PR #198)

Two tests failing on main since prior refactors; unrelated to today's aggregator work but noticed during verification.

- **`ReportingAgent.test.ts` › should generate risk report** — ZK proof generation in `generateRiskReport(includeZKProofs:true)` invokes the Python prover without a per-request deadline. Unreachable prover → 30s Jest timeout. Wrapped in `Promise.race` against 5000ms (env-tunable via `REPORTING_ZK_TIMEOUT_MS`); existing try/catch handles rejection so reports complete best-effort. Prod benefit: any endpoint that includes ZK proofs no longer blocks for 30s when the prover is down.
- **`agent-harness.test.ts` › drives LeadAgent intent parsing via the mocked LLM (JSON path)** — `LeadAgent.parseNaturalLanguage` was refactored to route through `reason()` in `lib/services/ai/reasoner` (uses `runWithTools` + provider-abstract ChatClient) instead of calling `llmProvider.generateResponse` directly. Test harness only mocked the old seam. Extended `installMockLLM` to `jest.doMock('@/lib/services/ai/reasoner')` too — records `reason()` calls as `method='generateDirectResponse'` for backward-compat with existing assertions.

### Results

Coverage grew from ~7 sources per asset to **19 for BTC** (4 AI + 3 broad + 3 Delphi + 3 Manifold + others). First two post-improvement paper trades opened at 01:12 UTC-4 both closed profitable: **paper-trader +$37.25**, **paper-gated +$26.41** (paper-gated crossed into positive PnL for the first time; n=2 too small for statistical conclusion but directionally the aggregator upgrades produce signal-consistent decisions).

### New env vars

- `POLY_MOMENTUM_TOP_N` (default 200) — momentum snapshot slot size in `poly-discover-tick`
- `REPORTING_ZK_TIMEOUT_MS` (default 5000) — ZK proof generation deadline in `ReportingAgent`

### Structural gaps not fixed (data-source-side)

- SUI + DOGE have zero markets in Polymarket top-100 by volume — nothing to wire
- Kalshi only offers BTC/ETH crypto binaries; no SOL/XRP/DOGE series

## [0.4.1] - 2026-08-04 — Pool wash-trade bleed stopped

### Autonomy — sample-rate + hysteresis

The pool kept bleeding after 3afc3085 shipped the per-asset stale-hedge fix. Deep-dive on the prod ring buffer found two execution-level chop loops. Signal quality wasn't the issue — sample-rate aliasing was.

- **agent-signal-tick confidence gate** (`app/api/cron/agent-signal-tick/route.ts:74`) — was firing `checkAndCloseDrifts` on every direction change including 39%-conf coin-flips. New env `SIGNAL_FLIP_MIN_CONF` (default 55) requires the NEW signal to meet confidence before treating the change as an actionable flip. State write is suppressed on suppressed flips so a noise flip doesn't rewrite the baseline and hide the next real one.
- **agent-signal-tick claim debounce 90s → 15 min** — `Polymarket5MinService` is a 5-minute binary market ("BTC up or down in 5 min"); sampling it every 90s produced 125 flips in 3h ring buffer with 48 at ≥85% conf. Not signal quality — sample-rate aliasing on a coin-flip market. New env `SIGNAL_TICK_INTERVAL_MS` (default 900_000). Matches the effective persistence of the underlying feed. QStash schedule (every 2 min) stays put; excess triggers no-op via claim debounce.
- **Profit-lock zero-risk hysteresis** (`lib/services/sui/cron/profit-lock-guard.ts:120`) — NAV oscillating around the 20% DD threshold triggered a wash-trade loop: sell all spot to USDC at 20% DD, buy back at 19% DD, sell again next tick (~4-6× per day at ~30-50 bps per round-trip). New env `PROFIT_LOCK_HYSTERESIS_PCT` (default 5); once in zero-risk, require drawdown to recover past `PROFIT_LOCK_ZERO_RISK_AT - PROFIT_LOCK_HYSTERESIS_PCT` before easing. `applyProfitLock` accepts `wasInZeroRisk` via existing `profit-lock:zero-since` cron_state key — no new state.
- **Test coverage** — 4 new unit tests in `test/unit/profit-lock-recovery.test.ts` covering enter/exit/no-hold/env-override cases. Bulletproof drawdown stays 10/10.

### Known structural (not code) limits
- At $29 pool NAV, BTC-PERP minQty (0.001 → $73 notional) and ETH-PERP minQty (0.01 → $30 notional) prevent proper hedging. Spot BTC/ETH sit naked-long → any market drop bleeds. Signal accuracy doesn't help when the venue's minQty prevents acting on it. Unblock is lifting the $10K TVL cap so deposits can grow the pool past the minQty gap.

## [0.4.0] - 2026-07-31 — Full autonomy on, DB slimmed, monster methods cracked

### Autonomy — defense gates now default ON
16-day trader idle streak (2026-07-15 → 2026-07-31) exposed several gaps between "gates exist" and "gates fire". Fixed end-to-end and verified with a real SOL trade opening + closing on venue.

- **envFlagOnByDefault helper** (`lib/utils/env-flag.ts`) — new companion to `envFlag`; returns true unless env is explicitly `0|false|no|off`. Applied to `PORTFOLIO_DRIVER_EXECUTE`, `STALE_HEDGE_AUTO_CLOSE`, `ALERT_RESPONSE_EXECUTE` at every execution + observability site (health/production, platform/risk-overview, admin/config-manifest). `ALERT_RESPONSE_EXECUTE_HALT` stays default OFF per rollout order.
- **Trader exposure cap decoupled** (`app/api/cron/polymarket-edge-trader/route.ts:1315`) — was counting ALL BlueFin positions (including SUI pool dual-leg) toward its own cap. Now measures only the trader's own contribution via KEY_ACTIVE re-read. Pool positions remain visible to BlueFin liquidation math but no longer freeze the trader.
- **Trader exposure cap raised** — default 30 → 60% (`lib/services/trading/trade-quality-gates.ts`) + prod env `TRADE_MAX_TOTAL_NOTIONAL_PCT=250`. Trader leverage raised to `POLYMARKET_EDGE_LEVERAGE=5` (max cap).
- **Autohedge phantom-zero halt guard** (`lib/services/sui/cron/step-8-auto-hedge.ts:101`) — the drawdown-halt no longer trips on `navUsd <= 0`. 2026-07-30 incident: dead SUI public RPC → `computeUsdcNav` returned 0 → halt logic saw "100% below peak $36.27" and paused autohedge for the full UTC day.
- **Phantom-rate detector excludes reconstructed_*** (`app/api/health/production/route.ts` + `alert-response-loop/route.ts`) — `bluefin-db-reconcile` adopts real BlueFin fills with `realized_pnl=0` (legitimately — no fill data at close time). Was flagging real trades as phantom. Now filters `order_id NOT LIKE 'reconstructed_%'`.

### Dashboard — honest UI
- **Always-visible ATH drawdown chip** (`components/dashboard/community-pool/PoolStats.tsx`) — amber ≤-5%, red ≤-15%. Was hidden in 10px subtext on desktop only; mobile users never saw drawdown at all.
- **Normalized stale chip wording** across mobile + desktop breakpoints (was two different strings).
- **Deduplicated card layouts** — extracted `Metric` component; mobile-hero, mobile-strip, desktop grid all render through it.
- **Removed silent SUI 100% fallback** (`components/dashboard/community-pool/mappers.ts`) — was lying when the server didn't return allocations. Now returns all-zeros so callers can render "unavailable" honestly.
- **Honest hedge-count sub-label** — "Active hedges" now says `≥ $1 notional, all sources` (was silently excluding micro-hedges without saying so).

### DB — cleanup + auto-prune
Audit surfaced 32,259 orphaned rows in `cron_state` (13 MB table, mostly stale `poly-momentum:history:*` entries from markets that resolved months ago). One-shot cleanup + code to prevent recurrence.

- **poly-momentum:history:* rows older than 7 days auto-pruned** each poly-discover tick (`lib/services/market-data/poly-discover-tick.ts`). Cleaned 27,399 stale rows one-shot.
- **poly-discover:seenBroadSlugs capped at 2000 items** — was unbounded (1.2 MB blob parsed on every discover tick). Cap = ~10 days of new-market memory.
- **`cron_state` table size 13 MB → 12 MB** post-vacuum (heap freed for reuse).

### Refactor — monster methods cracked
Extractions preserve behavior 1:1; typecheck clean, bulletproof drawdown test stayed 10/10 green throughout.

- **BluefinService** 1632 → 975 LOC (-40%). `openHedge` (435 LOC method) → `bluefin/open-hedge-impl.ts` + `closeHedge` (273 LOC method) → `bluefin/close-hedge-impl.ts`. Both take a `Context` bundle matching the pattern from `bluefin/dry-run-hedge.ts`.
- **llm-provider** 1223 → 1074 LOC. `generateFallbackResponse` (161-LOC keyword switch → canned responses) → `lib/ai/fallback-responses.ts`.
- **polymarket-edge-trader** 1680 → 1638 LOC. `riskGate` lifted to `lib/services/trading/trade-quality-gates.ts` (natural home alongside `exposureCap`, `fundingEdge`, `regretBasedHalt`); now pure — takes leverage/minQty as args.

### Skipped (audit was wrong)
- **HedgingAgent** — my ponytail-audit reported "839-LOC method" but that was a *range* between two grep markers, not a single function. Actual: 10 methods averaging 100 LOC each. Splitting = theater.
- **AutoHedgingService** — audit reported "assessPortfolioRisk 757 LOC"; actual is 101 LOC. Biggest is `assessCommunityPoolRisk` at 332 LOC (one coherent per-chain assessment — long but linear).

### Deferred
- **useCommunityPool 627-LOC handleDeposit callback** — genuine monster, but React state + chain-switching + permit-signing across 4 wallets. Needs a dedicated PR with manual UI testing.

### Deploys this session
- `6217104c` defense stack + gates default ON
- `4c4dd5e3` trader exposure cap decoupled
- `6148ab9f` dashboard honest allocations + Metric + DB prune
- `b947a06b` phantom-rate false positive fix
- `42cc5173` riskGate extraction
- `e2e5bd4d` BluefinService open/close extraction
- `67ae070e` llm-provider fallback extraction

## [0.3.0] - 2026-07-15

### Added — 8-gate autonomy defense system
Shipped after a real drawdown revealed that existing autonomy layers (profit-lock, hedgeability clamp, drift-close) were prescriptive — they gated future rebalances but never actively reshaped existing holdings. Each gate defends a specific failure mode; the full stack is verified by `test/integration/pool-drawdown-defense.test.ts` (10/10 green).

- **PortfolioDriver** (`lib/services/sui/PortfolioDriver.ts`) — corrective unwind actions on existing spot/perp holdings; emits `SELL_SPOT_TO_USDC` / `BUY_SPOT_FROM_USDC` / `OPEN_HEDGE` / `CLOSE_HEDGE` given current state + signal + drawdown
- **HedgeFillVerifier** (`lib/services/sui/HedgeFillVerifier.ts`) — post-open `getPositions()` cross-check to catch BlueFin silent-rejects
- **applyHedgeabilityClamp** (`lib/services/sui/cron/allocation.ts`) — spot cap → 0% when perp min-qty unopenable at NAV
- **Symmetric sell trigger** (in PortfolioDriver) — mirror of the buy trigger; opposing signal ≥ 65% reduces allocation
- **StaleHedgeDetector** (`lib/services/sui/StaleHedgeDetector.ts`) — age > 7d + ≥ 2 signal flips + contradicted side → force-close candidate
- **Signal-flip drift-close for spot** (in `app/api/cron/agent-signal-tick/route.ts`) — spot leg unwind on direction flip
- **regret-tracker** (`lib/services/ai/regret-tracker.ts`) — confidence-weighted rolling outcome; scales stake by [0.25, 1.0]
- **alert-response-loop** (`lib/services/alerting/alert-response-loop.ts` + `/api/cron/alert-response-loop`) — 3 KILL/hr → shrink; 24h profit-lock → unwind; phantom rate > 1% → halt

### Env gates
All destructive actions ship behind env flags (default OFF) so operators can log-observe first:
- `PORTFOLIO_DRIVER_EXECUTE=1` — actual SELL/BUY/OPEN/CLOSE actions
- `STALE_HEDGE_AUTO_CLOSE=1` — force-close stale hedges
- `ALERT_RESPONSE_EXECUTE=1` — auto-response actions
- `ALERT_RESPONSE_EXECUTE_HALT=1` — HALT_TRADER / HALT_AUTOHEDGE responses
- `REGRET_TRACKER_DISABLE=1` — default ON in polymarket-edge-trader stake calc

### Changed
- `notifyDiscord` now appends KILL/ERROR/WARN alerts to `cron_state` ring buffer key `alert-log:ring-buffer` (200-entry cap) for alert-response-loop consumption
- `polymarket-edge-trader` stake sizing composes regret multiplier with existing signal-strength multiplier
- `sui-hedge-reconcile` cron runs stale-hedge detection each tick (log-only by default)
- `sui-community-pool` cron invokes PortfolioDriver after profit-lock decision

### New QStash schedule required
The `/api/cron/alert-response-loop` route needs an Upstash schedule (every 15 min) — see [DEPLOY_RUNBOOK.md](./DEPLOY_RUNBOOK.md) for the `curl` snippet.

### Tests
- New: `test/integration/pool-drawdown-defense.test.ts` — 10 tests, live-read/sandbox-write drawdown replay
- New: `test/unit/portfolio-driver.test.ts` — 10 unit tests locking Gap 1/2/5 invariants
- New: `test/unit/hedge-fill-verifier.test.ts` — 11 unit tests for `verifyFill` polling + `computePhantomRate`
- Regression: 412 pre-existing tests still green

### Post-ship follow-ups landed (2026-07-15 audit)
Deep audit surfaced 8 gaps between the log-only defense and actual execution — all closed:

- **PortfolioDriver execution wired** in `app/api/cron/sui-community-pool/route.ts`. When `PORTFOLIO_DRIVER_EXECUTE=1`:
  - `SELL_SPOT_TO_USDC` actions batched into `replenishAdminUsdc` (reuses existing admin-asset → USDC swap path via BluefinAggregator)
  - `CLOSE_HEDGE` actions call `BluefinService.closeHedge({ symbol })` per hedge
  - `BUY_SPOT_FROM_USDC` / `OPEN_HEDGE` deferred to Step 7 allocation-driven swap (no double execution)
  - Discord posts EXECUTED N/M ratio; failures logged per-action
- **Alert-response `SHRINK_SPOT` / `UNWIND_ALL_SPOT` now execute** — write to `cron_state` key `alert-response:spot-target-risk-cap` (6h TTL). `sui-community-pool` reads this after profit-lock and applies the tighter cap (min of profit-lock + override), then PortfolioDriver unwinds to hit it.
- **Phantom hedge rate on `/api/health/production`** — new `checkPhantomRate()` component uses the bulletproof test's meta-invariant query (closed hedges, notional ≥ $1, `realized_pnl = 0` in last hour). Warn > 1%, down > 5%. Alert-response-loop's phantom-halt rule now has a real data feed.
- **SafeExecutionGuard interface comments** corrected: 30 bps / 4× (matches runtime defaults on lines 85-86).
- **3-asset comments** in `community_pool_usdc.move` header + `sui-community-pool/route.ts` header (last stale "4-asset / CRO" references in shipped code).

### Known follow-ups (documented, operator action)
- QStash schedules for `alert-response-loop` and re-add of `health-monitor` — Upstash-managed; see `DEPLOY_RUNBOOK.md` Appendix X for the `curl` snippet.
- `PORTFOLIO_DRIVER_EXECUTE=1` flip in Vercel env after log-observe window (recommended: 24h of `[log-only]` Discord messages first).

---

## [0.2.0] - 2026-06-12

### Added — SUI Mainnet USDC Community Pool
- Package `0x107292a69eea2f6eaf4a4e4727ee25d747b04c1985441b138933f0ef33f7b726` deployed (UpgradeCap v3)
- USDC pool state `0xe814e0948e29d9c10b73a0e6fb23c9997ccc373bed223657ab65ff544742fb3a`
- External NAV oracle — fixes prior share-math underpayment (per-share $1.91 vs $0.045 pre-fix)
- Strict mode ON (`admin_set_external_nav_required(true)`) — deposits/withdrawals revert with `E_EXTERNAL_NAV_STALE` if cron oracle attestation > 2h stale
- TVL cap $10K (`admin_set_tvl_cap`) — phased ratchet planned
- `close_hedge` funds-verify — drain prevention via AgentCap
- `zk_proxy_vault` cross-proxy + 4 ZK contracts with ed25519 prover attestation
- 15 internal audit phases (14 Move + 1 off-chain TS)
- 7-agent orchestrator (Lead / Risk / Hedging / Settlement / Reporting / PriceMonitor / SuiPool)
- SafeExecutionGuard — 2-of-3 consensus > $100K, position/slippage caps, circuit breaker
- BluefinAggregatorService — 6 DEXes on Sui (Cetus / DeepBook / Turbos / FlowX / Aftermath / BlueFin) via `@bluefin-exchange/bluefin7k-aggregator-sdk`
- Prediction-market signal pipeline (`PredictionAggregatorService`) — Polymarket 5-min + Delphi/Polymarket + Manifold + Crypto.com + BlueFin funding
- Autonomous perp trader (`polymarket-edge-trader` cron, 5-min cadence)
- 10 production crons on Upstash QStash with heartbeats + idempotency claims

### Changed
- Migrated database: Neon → Aiven PostgreSQL (Bangalore PG17)
- BlueFin `openHedge` uses `isIsolated: true` (fixes silent-reject bug from ISOLATED-only exchange support)
- `closeHedge` snaps to per-symbol stepSize (fixes prior silent-reject class)
- Move contract read-through: `max_hedge_ratio_bps` from chain (never hardcode)

### Deprecated
- v0.1.0 package `0x9ccb…cd83e598c88` — dormant; pool state preserved through upgrade
- MSafe treasury (reverted for autonomous hedging; MSafe still holds `FeeManagerCap`)

### Fixed
- Withdrawal underpayment (2026-06-03) — pool `calculate_assets_for_shares` now includes off-chain wBTC/wETH/SUI market value
- CRLF trap on Vercel env values — `.trim()` on every SUI env read + `instrumentation.ts` sanitises on cold start
- u64 overflow guard (`lib/services/sui/safe-bigint.ts`) — NAV up to `NAV_SAFETY_CEILING_USDC=500_000_000`

### Security
- 15 internal audit phases completed (see [`AUDIT_2026-06-04.md`](./AUDIT_2026-06-04.md), [`AUDIT_2026-06-12_phase15_offchain.md`](./AUDIT_2026-06-12_phase15_offchain.md))
- OFAC geo-block middleware (KP, IR, SY, CU, RU, BY)
- Strict NAV-oracle mode ON

---

## [0.1.0] - 2026-01-02

### Added
- 🤖 **5 Specialized AI Agents**
  - Lead Agent: Orchestration and strategy coordination
  - Risk Agent: Portfolio risk analysis (VaR, volatility, Sharpe ratio)
  - Hedging Agent: Optimal hedge strategy generation
  - Settlement Agent: Gasless transaction execution with x402
  - Reporting Agent: Comprehensive analytics and insights

- 🔐 **ZK-STARK Privacy Layer**
  - Real cryptographic proof generation (521-bit NIST P-521)
  - CUDA GPU acceleration (12ms proof generation)
  - On-chain verification with ZKVerifier contract
  - Privacy-preserving portfolio analytics

- ⚡ **x402 Gasless Protocol Integration**
  - Zero gas fees for settlements ($0.00 CRO)
  - USDC-based payment routing
  - 97.4% test coverage
  - GaslessZKVerifier smart contract

- 🎨 **Modern Dashboard UI**
  - Real-time portfolio monitoring
  - Interactive risk metrics visualization
  - Agent activity tracking with ZK proof verification
  - Wallet connection with WDK (self-custodial EVM wallet)
  - Dark/Light theme support

- 📊 **Smart Contract Suite**
  - RWAManager: Portfolio and asset management
  - ZKVerifier: Zero-knowledge proof verification
  - PaymentRouter: Multi-token payment handling
  - GaslessZKVerifier: Gasless transaction processing
  - All contracts deployed on Cronos testnet (ChainID 338)

- 🧪 **Comprehensive Testing**
  - 70/70 tests passing (100% success rate)
  - 10/10 E2E integration tests
  - 41/41 on-chain smart contract tests
  - 19/19 AI agent tests
  - Live API testing (CoinGecko, Cronos RPC)

- 📚 **Documentation**
  - Architecture overview
  - Deployment guide
  - Test guide
  - API documentation
  - Setup instructions
  - Security policy

### Technical Stack
- **Frontend**: Next.js 14, React 18, TypeScript, TailwindCSS
- **Smart Contracts**: Solidity 0.8.22, Hardhat, OpenZeppelin
- **Blockchain**: Cronos EVM Testnet (ChainID 338)
- **AI/ML**: Crypto.com AI Agent SDK, OpenAI GPT-4
- **Privacy**: ZK-STARK proofs, CUDA acceleration, Python FastAPI
- **Payments**: x402 Facilitator, USDC settlements
- **Testing**: Jest, Hardhat, TypeScript

### Deployed Contracts (Cronos Testnet)
- RWAManager: `0x1Fe3105E6F3878752F5383db87Ea9A7247Db9189` (Updated Jan 16, 2026 - with transaction events)
- ZKVerifier: `0x46A497cDa0e2eB61455B7cAD60940a563f3b7FD8`
- PaymentRouter: `0xe40AbC51A100Fa19B5CddEea637647008Eb0eA0b`
- GaslessZKVerifier: `0x44098d0dE36e157b4C1700B48d615285C76fdE47`
- USDC Token: `0xc01efAaF7C5C61bEbFAeb358E1161b537b8bC0e0`

### Security
- All contracts inherit from OpenZeppelin battle-tested implementations
- Access control with Ownable pattern
- Reentrancy guards on sensitive functions
- Integer overflow protection (Solidity 0.8+)
- Comprehensive input validation

---

## [Unreleased]

### Planned
- Mainnet deployment on Cronos zkEVM
- Additional AI models for portfolio optimization
- Multi-chain support (Ethereum, Hedera)
- Advanced hedging strategies (options, perpetuals)
- Historical performance analytics
- Mobile app (React Native)

---

## Release Notes Format

### Types of Changes
- `Added` for new features
- `Changed` for changes in existing functionality
- `Deprecated` for soon-to-be removed features
- `Removed` for now removed features
- `Fixed` for any bug fixes
- `Security` for vulnerability fixes

### Semantic Versioning
- **MAJOR** version: Incompatible API changes
- **MINOR** version: Backwards-compatible new features
- **PATCH** version: Backwards-compatible bug fixes

---

**Note**: This project is currently in beta (0.x.x versions). Breaking changes may occur between minor versions until 1.0.0 release.
