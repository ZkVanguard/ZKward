# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning: [SemVer](https://semver.org/spec/v2.0.0.html).

## [0.4.2] — 2026-09-21

### Changed

- Prediction aggregator wires previously-idle broad-markets, momentum, and
  theme-detection services; source weights recalibrated against resolved
  hit-rate history
- `HedgingAgent` now consults the aggregator before voting, replacing the
  partial-data override that shadowed the aggregator directive

### Fixed

- Kalshi resolved-market filter (`yes_price ∈ [0.02, 0.98]`) drops stale
  brackets that produced spurious `direction=DOWN`
- Two pre-existing test seams (`ReportingAgent` ZK deadline,
  `agent-harness` reasoner mock) unblocked

## [0.4.1] — 2026-08-04

### Fixed

- Pool wash-trade bleed traced to sample-rate aliasing on a 5-minute binary
  feed, not signal quality
- `SIGNAL_FLIP_MIN_CONF` (default 55) suppresses coin-flip flips
- `SIGNAL_TICK_INTERVAL_MS` (default 15 min) matches the underlying feed's
  persistence
- Profit-lock exit hysteresis (`PROFIT_LOCK_HYSTERESIS_PCT`, default 5)
  ends the sell-buy-sell chop around the zero-risk threshold

## [0.4.0] — 2026-07-31

### Changed

- 8-gate defense stack now default-on via `envFlagOnByDefault`; destructive
  actions still gate-checked
- Autonomous trader exposure cap decoupled from pool-owned positions
- Monolith split: `BluefinService` -40%, `llm-provider` and
  `polymarket-edge-trader` extracted

### Fixed

- Autohedge drawdown-halt no longer trips on `navUsd <= 0` from stale RPC
- Phantom-rate detector excludes reconciler-adopted `reconstructed_*`
  orders
- Dashboard shows honest allocations instead of a 100% fallback

## [0.3.0] — 2026-07-15

### Added — 8-gate autonomy defense

Ships after a drawdown revealed the existing autonomy layers were
prescriptive (gated future rebalances) but never reshaped existing
holdings.

- `PortfolioDriver` — corrective unwind of existing balance sheet
- `HedgeFillVerifier` — post-open cross-check catches silent-rejects
- `applyHedgeabilityClamp` — spot cap → 0% when perp minQty unopenable
- Symmetric sell trigger on opposing signal ≥ 65%
- `StaleHedgeDetector` — > 7d + ≥ 2 flips + contradicted side
- Signal-flip drift-close on the spot leg
- `regret-tracker` — confidence-weighted stake scaling
- `alert-response-loop` — 3 KILL/hr → shrink, 24h profit-lock → unwind,
  phantom rate > 1% → halt

### Added — Verification

- `test/integration/pool-drawdown-defense.test.ts` (10/10 green — must
  stay green)

## [0.2.0] — 2026-06-12

### Added — SUI Mainnet USDC Pool

- Package
  `0x107292a69eea2f6eaf4a4e4727ee25d747b04c1985441b138933f0ef33f7b726`
- USDC pool state
  `0xe814e0948e29d9c10b73a0e6fb23c9997ccc373bed223657ab65ff544742fb3a`
- External NAV oracle (strict mode ON)
- Contract-enforced TVL cap $10K
- `close_hedge` funds-verify via AgentCap
- `zk_proxy_vault` cross-proxy + 4 ZK contracts (ed25519 attestation)
- 7-agent orchestrator with `SafeExecutionGuard`

### Fixed

- Withdrawal underpayment (per-share $1.91 vs $0.045 pre-fix)
- CRLF trap on env values (`.trim()` at every SUI env read)
- u64 overflow guard for large NAV

### Security

- 15 internal audit phases (14 Move + 1 off-chain)
- OFAC geo-block middleware
- Strict NAV-oracle mode

## [0.1.0] — 2026-01-02

### Added

- 5-agent orchestrator (Lead, Risk, Hedging, Settlement, Reporting)
- ZK-STARK privacy layer (Python prover, NIST P-521)
- x402 gasless settlement
- Dashboard with self-custodial wallet
- Contract suite on Cronos testnet

---
Detailed release notes for internal reference live outside the public tree.
