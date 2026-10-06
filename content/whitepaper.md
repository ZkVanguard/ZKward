---
title: ZKward Whitepaper
subtitle: An AI-managed USDC vault that trades on prediction-market and market-structure signals, and measures every signal in public. Accounting is on-chain on SUI mainnet. A proof system is in development and not in use.
version: Version 2.3
date: October 2026
---

## Abstract

ZKward is a live USDC vault on SUI mainnet. Six agents read Polymarket, BlueFin funding, and mid-cap price momentum; allocate across BTC / ETH / SUI; and hedge on BlueFin perps. Deposits, withdrawals, shares and fees are recorded on-chain. The pool is capped at $10K by the Move contract during the operational-proof phase — this is not a scaling claim, it is a discipline. Cap-lifting is a governance action, not a code change.

Prediction-market volume reached $20B/month in early 2026 (Polymarket) and the sector grew to $63.5B in 2025 (CertiK). The signal is liquid enough to trade at retail size. What has been missing is accountability: most AI-agent products are black boxes. ZKward publishes how each signal source has performed and keeps the vault accounting on-chain. A cryptographic proof of each decision is a goal, not a feature that exists today (see "Proofs: what exists and what does not").

Two revenue paths run today. On-chain: 50 bps annual management + 10 % performance, routed through a MSafe-held `FeeManagerCap` distinct from the operational `AdminCap`. Off-chain: tiered subscriptions for private hedges and the private portfolio creator. The consumer flow proves the ZK rails; the subscription flow prices them.

Live: package `0x107292…7b726` (v0.2.0), pool state `0xe814…fb3a`, eight autonomy defense gates, and `bun jest test/integration/pool-drawdown-defense.test.ts` gating every merge.

## Why prediction-market alpha needs infrastructure

Three barriers stop retail from harvesting the signal.

- **Operational cost.** Riding prediction-market alpha continuously needs bots, monitoring, and 24/7 attention. Fine for a fund. Impossible for a solo depositor.
- **Missing risk management.** A directional signal without sizing, stops, and a hedge leg is a way to get liquidated by the same move you predicted.
- **Unverifiable AI.** "Our model is great" is the industry claim. Every AI-agent crypto product ships a black box; users are asked to trust a team.

The convergence that makes 2026 the moment: Polymarket has real liquidity, ZK-STARKs finally verify in sub-second on commodity hardware, and consumer on-chain UX (smart accounts, sponsored gas, one-click deposits) closes the last-mile gap. Bittensor, ASI Alliance, Fetch, and MyShell all crossed $1B market cap — the market has decided AI-managed workflows are the frontier. The open question is trust.

## What we do differently: signals, measured in public

Traditional risk management reacts: an event fires, an alert lands, a human reviews, orders go in. ZKward acts on signals instead. A scheduled job reads the aggregator, sizes the hedge, opens on BlueFin, and verifies the fill via the `getPositions()` delta.

Whether those signals lead the price is an empirical question, and we treat it as one. Every source's call is recorded and scored against the price that followed at fixed horizons (30, 60 and 240 minutes), whether or not anything traded. Evidence is counted over non-overlapping windows, coins that move together count as one observation, and a verdict has to survive a false-discovery check.

**What the record shows as of October 2026.** No source and no source family has yet shown an edge that clears that bar. The combined signal's return in its own direction is indistinguishable from zero from 5 minutes to 4 hours. The two best leads are order-book imbalance and one regulated prediction venue at the 60-minute horizon (about +5 bp each, at roughly two standard errors): leads, not proof. The simulated books that trade the signal are slightly negative after costs. We publish this because a claim of edge that nobody can check is the problem this project exists to answer.

## Architecture, without the diagram

Four layers. Every capital-touching action passes through all four. Diagnostics can short-circuit at any layer.

1. **UI.** Next.js 16 App Router, React 19, Tailwind, 13-locale i18n. No wallet SDK on marketing pages (that bundle is lazy-loaded on /dashboard). PWA-registered.
2. **Agent orchestration.** Six typed agents behind `SafeExecutionGuard`: single-trade cap $10M, daily cap $100M (UTC reset), 30 bps slippage ceiling, 4× leverage ceiling, 2-of-3 consensus threshold above $100K, 5-second cooldown. The guard has a slot for a proof hash on executions above $1M; no execution has reached that size and none carries one.
3. **Data + integration.** Polymarket, Delphi, Manifold, Crypto.com prices, Pyth oracles, BlueFin (perps + funding), Kalshi (ATM strike), Deribit (implied vol), Binance and Bybit (funding, open interest, order-book depth), options skew. 20-second TTL in a shared aggregator. Self-hosted PostgreSQL 18 for off-chain state.
4. **Blockchain.** SUI mainnet Move contracts (pool + hedge executor + proxy vault) as the lead chain. A USDC vault on Hedera testnet and a token pool on Solana devnet run in the same app with test funds. Sepolia, Cronos EVM, Oasis Sapphire and Arbitrum Sepolia are reference deployments.

### The six agents

Lead (intent parse), Risk (VaR + Sharpe + drawdown), Hedging (fused-signal hedge ratio), Reporting (proof-optional summaries), Price Monitor (cross-source sanity), and SUI Pool (signal reasoning for the community pool cron). A seventh, Settlement, served the gasless-payment flow and was removed with it; its vote is now a rule inside the Lead agent. Cron routes generally bypass agents for latency, with the SUI cron lazily instantiating `getSuiPoolAgent()`.

### Live contracts (SUI mainnet, v0.2.0)

- **Package:** `0x107292a69eea2f6eaf4a4e4727ee25d747b04c1985441b138933f0ef33f7b726`
- **Pool state:** `0xe814e0948e29d9c10b73a0e6fb23c9997ccc373bed223657ab65ff544742fb3a`
- **Capabilities:** `AdminCap` (currently hot, migrating to MSafe via the OracleCap split in v0.4.0), `FeeManagerCap` (MSafe), `OracleCap` (planned split; hot key attests NAV without touching pool authority).
- **TVL cap:** $10,000, enforced by the Move contract. Governance action required to lift.

Prior deployment (v0.1.0 at `0x9ccb…c88`) is dormant. The withdrawal-underpayment bug that motivated the v0.2.0 redeploy is fixed on-chain; reproduce via `bun run scripts/analyze-pool-pnl.ts`.

## Proofs: what exists and what does not

Earlier versions of this paper said that every hedge decision carries a STARK proof verified on-chain. That was not true, and an internal review in October 2026 established how far from true it was. This section replaces those claims.

**What exists.** A STARK prover written in Python (Goldilocks field, SHA-256 Merkle trees, FRI, Fiat–Shamir, with a GPU path), a canonical encoding of a hedge decision into a commitment hash, and Move source for an on-chain verifier.

**What does not.**

- **No trade carries a proof.** The job that opens and closes hedges does not call the prover. No hedge record has a proof attached, and no proof has been verified on-chain.
- **The on-chain STARK verifier is not deployed.** The package on SUI mainnet contains an older module that checks a signature, not a STARK. The STARK verifier exists in source only.
- **The prover is not sound.** The review produced proofs the verifier accepts for statements that are false, including a hedge with leverage far above its cap, and a proof built from random numbers. The low-degree test does not constrain the committed function, the trace is not tested, and openings are not bound to their positions.
- **The statement would not bind a trade even if it were sound.** It asserts that an asset code, a side and a leverage within a cap exist. It does not tie them to the order that was placed, its size, its price or its time.
- **It is not zero-knowledge.** The witness can be recovered from a proof.

**What you can check instead.** Every deposit, withdrawal, share issuance, fee and transfer out of the pool is a SUI transaction. The pool's share price comes from the on-chain balance plus a value the operator attests; that attestation is a trust assumption, bounded by the contract but not eliminated. Signal quality is measured in public, as described above.

**What would have to be true before we claim proofs again.** A sound verifier (an audited library, or this one fixed and independently reviewed), a statement that binds the proof to the executed order, the verifier deployed on-chain, and execution that refuses to proceed without a verified proof.

No external audit has been completed; all review so far is internal.

## Autonomy defense (v0.3.0 — 8 gates)

Between June and July 2026 the pool took a 30 % drawdown. Root cause was subtle: existing autonomy layers were **prescriptive** — they gated *future* rebalances but never reshaped existing holdings. When a signal flipped, the trader stopped opening new positions but the old ones sat. v0.3.0 closes those gaps.

| # | Module | What it enforces |
|---|---|---|
| 1 | `PortfolioDriver` | Actively unwinds spot when the target changes, not just gates new fills. |
| 2 | `HedgeFillVerifier` | `getPositions()` delta cross-check. Silent BlueFin rejects can't hide behind an `orderHash`. |
| 3 | `applyHedgeabilityClamp` | When `allocation × NAV` falls below a venue's min-quantity, redirect to USDC instead of leaving spot naked. |
| 4 | Symmetric-sell logic | SELL and BUY paths use the same size math and the same guards. |
| 5 | `StaleHedgeDetector` | Auto-closes hedges older than N days that have flipped M times. |
| 6 | Signal-flip drift-close | `agent-signal-tick` closes drift when the signal flips confidently. |
| 7 | Regret-weighted trader | `polymarket-edge-trader` stake sized by prediction PnL. |
| 8 | `alert-response-loop` | Reads a 200-entry ring buffer; can `HALT_TRADER` or `HALT_AUTOHEDGE` when phantom-fill rate exceeds threshold. |

Every destructive action is env-gated. Rollout was staged: log-only first, then execution one gate at a time (`PORTFOLIO_DRIVER_EXECUTE` → `STALE_HEDGE_AUTO_CLOSE` → `ALERT_RESPONSE_EXECUTE` → `ALERT_RESPONSE_EXECUTE_HALT`). All four are on in production as of October 2026; the health endpoint reports their state. `bun jest test/integration/pool-drawdown-defense.test.ts` stays green through every merge — that test is the operational contract.

## Signal fusion

Each asset has its own source list. A source votes UP or DOWN with a confidence and a base weight; the aggregator caches the result for 20 seconds. The table lists the base weights in code today.

| Source | Base weight | Notes |
|---|---|---|
| Polymarket 5-minute market | 25 % (35 % when cross-asset fusion upgrades it) | Direction from the market's odds against spot, never from the question's wording |
| Polymarket 5-minute ticker (BTC) | 10 % | |
| Polymarket hourly and daily markets | shared across the matching markets | |
| Kalshi | 15 % | Regulated US prediction contract |
| BlueFin funding | 20 % | Votes only when funding is crowded (above 0.03 % per 8 h), contrarian |
| Binance funding, Bybit funding | 12 % each | Same crowded-funding rule |
| Bybit open-interest change | 10 % | |
| Order-book depth imbalance | 13 % | |
| Options skew (risk reversal) | 11 % | |
| Crypto.com 24 h price change | 10 % | |
| Cross-asset alignment | 15 % | Present only when most assets agree |
| Manifold, model-read market titles, themes | 4–10 % | |
| Deribit realized volatility | filter | Below 40 % annualized, the simulated book skips the entry |

Base weights are a starting point. The signal ledger described above then removes a source measured wrong-way and lifts one measured right; everything unproven keeps its base weight. A funding vote and a long/short-ratio vote that fired almost permanently in one direction were removed in October 2026 after a month of history showed they carried no timing information.

Hedge ratio is 50 % of exposure (100 % for pools under $1K), scaled by a confidence multiplier `1 + (probability − 0.5) × 0.5`, then clamped by on-chain `max_hedge_ratio_bps`. Example: a 73 % probability signal → 1.23× multiplier → `50 % × 1.23 = 61.5 %` exposure hedged.

### The small-NAV asymmetry

BlueFin's per-symbol minimum size creates a hedgeability gap at small NAV: BTC-PERP min 0.001 (~$73), ETH $30, SUI $4. When `allocation × NAV < floor`, the perp leg is skipped — leaving spot naked-long even under a BEARISH signal. Gate 3 in the defense table redirects that allocation to USDC; `PortfolioDriver` actively unwinds the pre-existing spot instead of documenting the exposure.

## Multi-chain

SUI is the lead chain by design. Other chains are proven at testnet level so pool logic can migrate when demand justifies it. The multi-chain surface is a capability, not a scattered focus.

| Chain | Role | Status |
|---|---|---|
| **SUI Mainnet** | Lead — pool, hedge executor | ✅ Live (v0.2.0) |
| Cronos EVM | Multi-chain reference; x402 gasless research | ✅ Deployed |
| Oasis Sapphire | Confidential-EVM primitive validation | ✅ Testnet |
| Arbitrum Sepolia | L2 pool + hedge reference | ✅ Testnet |
| Hedera Testnet | USDC vault with email sign-in (test funds), HCS audit topic, GraphQL adapter (npm-published) | ✅ Testnet |
| Solana Devnet | Token pool with ledger-priced shares (test tokens) | ✅ Devnet |

## Security

**Contracts.** OpenZeppelin where EVM applies; Move code uses `sui::` with explicit `entry` boundaries. 15 internal audit phases completed (2026-06-04 through 2026-06-12). No external audit has been completed.

**Cryptographic.** Funds are secured by the SUI contract and standard SUI signatures. The STARK prover is experimental, is not sound, and secures nothing today (see "Proofs: what exists and what does not").

**Operational.** Non-custodial — the pool holds capital under Move object custody, not admin authority. Every cron uses `verifyCronRequest` + `tryClaimCronRun` (idempotency) + `setCronState` (heartbeat). Missing heartbeats trip alerts within one interval. Every capital-moving action fires a Discord alert and appends to `alert-log:ring-buffer`. Reconcilers cross-check on-chain Move ↔ BlueFin (hourly) and BlueFin ↔ DB (every 15 min). Pre-push hook runs the security scan on every push.

**Kill switches.** `SUI_AUTO_HEDGE_DISABLE=1` (halt), `HEDGE_MIN_NAV_USD` (default 20, 15 in production; hedge blocked below), `NAV_SAFETY_CEILING_USDC` (default 10B; halts writes above ceiling; Move u128 redeploy required before scaling past it).

## Economics

**Revenue on-chain.** 50 bps annual management + 10 % performance on realised profits. Routed through `FeeManagerCap` (MSafe multisig). `AdminCap` (currently hot, migrating to MSafe via OracleCap split) is a separate object — the fee path cannot be sacrificed to an admin key compromise.

**Revenue off-chain.** Subscription access to private hedges and the private portfolio creator. Consumer flow proves the ZK rails; subscription flow prices them.

**Capital state.** $10K contract-enforced TVL cap. Cap-lifting is a governance action (`sui-set-tvl-cap`, `CRON_SECRET`-gated), not a code change. `NAV_SAFETY_CEILING_USDC` default 10B halts writes above ceiling; scaling past requires the Move u128 redeploy.

**Cost.** Serverless functions in the Singapore region (`sin1`) for API + crons; pay-per-request, dominated by cron cadence and function memory. Self-hosted PostgreSQL 18 behind a connection pooler, and a self-hosted job scheduler since 2026-09-19.

Growth projections are omitted deliberately. The whitepaper describes what runs today, not a forecast.

## Roadmap

| When | What | Status |
|---|---|---|
| Q1 2026 | Cronos EVM (Moonlander, VVS, x402); STARK cutover to `CUDATrueSTARK` | ✅ |
| Q2 2026 | SUI mainnet pool v0.1.0 → v0.2.0; withdrawal-underpayment fix; TVL cap enforcement; multichain reference deploys | ✅ |
| Q3 2026 | v0.3.0 autonomy defense (8 gates); regret tracker; refactor arc (2,087 LOC → 15 pure modules); Aiven → Bakchodi migration | ✅ |
| Q4 2026 (current) | Signal ledger and a feedback loop that acts only on proven evidence; external audit (not yet commissioned); OracleCap split (v0.4.0) so AdminCap → MSafe fully; TVL cap raise post-audit | 🔧 |
| 2027+ | Cross-chain unified portfolio; Cronos zkEVM enhanced privacy path; expanded prediction sources | 📋 |

## Conclusion

ZKward is a live vault, not a pitch deck. Signals measured in public, six typed agents, an eight-gate defense system, a $10K contract-enforced cap during the operational-proof phase, and on-chain accounting. Cap-lifting is a governance action, not a code change. Ship what runs today.

## References

1. Ben-Sasson, E., Bentov, I., Horesh, Y., & Riabzev, M. *Scalable, transparent, and post-quantum secure computational integrity.* IACR ePrint 2018/046. <https://eprint.iacr.org/2018/046>
2. Ben-Sasson, E., Bentov, I., Horesh, Y., & Riabzev, M. *Fast Reed-Solomon Interactive Oracle Proofs of Proximity.* ICALP 2018. IACR ePrint 2018/828. <https://eprint.iacr.org/2018/828>
3. StarkWare Industries. *ethSTARK Documentation v1.2.* IACR ePrint 2021/582.
4. Polygon zkEVM. *Goldilocks Prime Field: efficient 64-bit field arithmetic for zkVMs.*
5. EIP-3009. *Transfer With Authorization.* 2020.
6. Boston Consulting Group. *Relevance of on-chain asset tokenization.* BCG Global, 2024.
7. CertiK. *Prediction Market Sector Report 2025.*
8. Polymarket. *Prediction Market Accuracy Analysis.*
9. Sui Foundation. *Move on SUI — Framework and Object Model.*
10. BlueFin Exchange. *Perpetual Futures API Reference.*
