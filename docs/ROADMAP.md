# ZKward Roadmap

Canonical roadmap. Mirrors the [main README](../README.md#roadmap) but with more context. Cap ratchets are contract-gated via `admin_set_tvl_cap` and unlock only against a specific evidence bundle — not aspirational.

---

## Shipped

### v0.1.0 — Beta (2026-01-02)
- 5 specialized AI agents (Lead / Risk / Hedging / Settlement / Reporting)
- ZK-STARK privacy layer (Python STARK prover, NIST P-521, CUDA-optional)
- x402 gasless protocol integration
- Smart-contract suite on Cronos testnet
- Dashboard with WDK self-custodial wallet
- 70/70 tests passing
- VVS Finance DEX integration
- Multi-chain foundation (Cronos + SUI configured)

### v0.2.0 — Sui Mainnet (2026-06-12)
- Package `0x107292a69eea2f6eaf4a4e4727ee25d747b04c1985441b138933f0ef33f7b726` live
- USDC pool state `0xe814e0948e29d9c10b73a0e6fb23c9997ccc373bed223657ab65ff544742fb3a`
- External NAV oracle (fixes prior share-math underpayment)
- Strict mode `ON` — deposits/withdraws revert on stale oracle
- TVL cap $10K (contract-enforced via `admin_set_tvl_cap`)
- `close_hedge` funds-verify (drain prevention via AgentCap)
- `zk_proxy_vault` cross-proxy + 4 ZK contracts ed25519 prover attestation
- 15 internal audit phases (see [`AUDIT_2026-06-04.md`](./AUDIT_2026-06-04.md), [`AUDIT_2026-06-12_phase15_offchain.md`](./AUDIT_2026-06-12_phase15_offchain.md))
- 7-agent orchestrator + `SafeExecutionGuard` (2-of-3 consensus, circuit breaker)
- BluefinAggregator (6 DEXes on Sui: Cetus · DeepBook · Turbos · FlowX · Aftermath · BlueFin)
- Prediction-market signal pipeline: Polymarket 5-min + Delphi/Polymarket + Manifold + Crypto.com + BlueFin funding

### v0.3.0 — 8-gate autonomy defense (2026-07-15)
Shipped after a real drawdown revealed passive-only defenses. Each gate defends a specific failure mode; verified by `test/integration/pool-drawdown-defense.test.ts` (10/10 green).

- **PortfolioDriver** — corrective unwind of existing balance sheet when profit-lock fires
- **Fill verifier** — post-open BlueFin `getPositions()` cross-check to catch silent-rejects
- **Hedgeability spot-cap** — spot allocation forced to 0 when perp min-qty unopenable at NAV
- **Symmetric sell trigger** — mirror of the buy trigger; opposing signal reduces allocation
- **Stale-hedge detector** — age > 7d + ≥ 2 signal flips + contradicted side → force-close
- **Signal-flip drift-close** — spot leg unwind on direction flip (not just perps)
- **AI regret weighting** — confidence-weighted rolling outcome scales stake by [0.25, 1.0]
- **Alert response loop** — 3 KILL/hr → shrink spot; 24h profit-lock → unwind; phantom rate > 1% → halt

Ships behind env flags so operator can log-observe before flipping to live execution. **Rollout state (verified 2026-07-23 via `/api/health/production` gate footprint):**

| Gate | State |
|---|---|
| `PORTFOLIO_DRIVER_EXECUTE` | ✅ ON |
| `STALE_HEDGE_AUTO_CLOSE` | ✅ ON |
| `ALERT_RESPONSE_EXECUTE` | ✅ ON |
| `ALERT_RESPONSE_EXECUTE_HALT` | ⏸ OFF (last gate held per rollout runbook) |

---

## Roadmap

### Q3 2026 — External audit + Founding-100

- 🔨 External audit close (SUI Foundation grant Tranche 1 deliverable)
- 🔨 TVL cap ratchet: **$10K → $100K**
- 🔨 Founding-100 points program live (3× multiplier for retail cohort)
- ✅ QStash schedule for `alert-response-loop` cron (scheduled `scd_7Z4yqbBAJgT5Vuof5Ce9uJKNBy8Y`, verified 2026-07-19)
- 🔨 Flip `ALERT_RESPONSE_EXECUTE_HALT=1` after log-observation window (most-destructive gate, deliberately last)
- 🔨 Dashboard: risk overview page enhancements + PnL time-series

**Success criteria for cap ratchet:** external audit findings resolved · 30-day incident-free window · > $50K deposited across ≥ 20 members.

### Q4 2026 — Institutional tier + first EVM expansion

- 🔨 TVL cap ratchet: **$100K → $1M**
- 🔨 Institutional tier live via `rwa_custody_attestor.move` — $2.5K enrollment + $0.50/attestation
- 🔨 First EVM chain deployment (target: chain with institutional partner demand)
- 🔨 Multi-venue perp hedging (Hyperliquid / dYdX beyond BlueFin V2)
- 🔨 Bug bounty program public (see [`BUG_BOUNTY.md`](./BUG_BOUNTY.md))

**Success criteria for cap ratchet:** > $500K deposited · zero drawdown-defense gate false-positives · custody attestor live with ≥ 1 institutional client.

### Q1 2027 — Enterprise + TGE

- 🔨 TVL cap ratchet: **$1M → $10M**
- 🔨 Enterprise white-label API — Aladdin-as-a-Service tier
- 🔨 TGE (utility token — governance over fee parameters, staking gates discounted vault fees)
- 🔨 Points → token bridge for Founding-100 cohort
- 🔨 Value capture: percentage of on-chain fees routes to staking rewards / buyback-burn (Pendle / GMX precedent)

**Success criteria for cap ratchet:** > $5M deposited · sustained 30-day uptime > 99.5% · multi-chain expansion validated.

---

## Beyond Q1 2027 (directional, not committed)

- **$100M TVL** — well below the current `NAV_SAFETY_CEILING_USDC=10B` cron gate, but a Move u128 redeploy is still the hard wall for fee/cap math beyond ~$500M
- **AdminCap MSafe migration** — `FeeManagerCap` already on MSafe; `AdminCap` still hot key
- **OTC desk relationships** — for splits above DEX aggregator liquidity
- **Insurance fund** — protocol-owned buffer against black-swan scenarios
- **Multi-signal fusion expansion** — Kalshi (once API stabilises), custom on-chain oracles, additional per-asset binary markets (Polymarket + Manifold already live)

See [`SCALABILITY_ANALYSIS.md`](./SCALABILITY_ANALYSIS.md) for the hard walls that constrain each tier.

---

## Not on the roadmap (explicit non-goals)

- **Own DEX or perp venue** — we route through BlueFin, Cetus, DeepBook et al. No plan to become a venue.
- **Public sale / ICO** — TGE is utility-first, no fundraising via retail sale.
- **KYC-gated retail deposits** — the vault is permissionless above the geo-block layer. Institutional tier is opt-in KYC via custody attestations.
- **Cross-chain bridge protocol** — we deploy per-chain; no bridge in scope.

---

**Last updated:** 2026-07-23 · Cross-referenced against [`../README.md`](../README.md) and shipped code.
