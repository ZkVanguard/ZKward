---
title: ZKward Whitepaper
subtitle: An AI-managed USDC vault that rides prediction-market alpha, with a STARK proof for every hedge decision. Live on SUI mainnet.
version: Version 2.1
date: September 2026
---

## Abstract

ZKward is a live USDC vault on SUI mainnet. Seven agents read Polymarket, BlueFin funding, and mid-cap price momentum; allocate across BTC / ETH / SUI; hedge on BlueFin perps; and commit a zero-knowledge STARK proof of each hedge decision on-chain. The pool is capped at $10K by the Move contract during the operational-proof phase — this is not a scaling claim, it is a discipline. Cap-lifting is a governance action, not a code change.

Prediction-market volume reached $20B/month in early 2026 (Polymarket) and the sector grew to $63.5B in 2025 (CertiK). The signal is liquid enough to trade at retail size. What has been missing is verifiable execution: most AI-agent products are black boxes. ZKward publishes the signal weights, the sizing math, and a post-quantum STARK proof for every decision that moves capital.

Two revenue paths run today. On-chain: 50 bps annual management + 10 % performance, routed through a MSafe-held `FeeManagerCap` distinct from the operational `AdminCap`. Off-chain: tiered subscriptions for private hedges and the private portfolio creator. The consumer flow proves the ZK rails; the subscription flow prices them.

Live: package `0x107292…7b726` (v0.2.0), pool state `0xe814…fb3a`, eight autonomy defense gates, and `bun jest test/integration/pool-drawdown-defense.test.ts` gating every merge.

## Why prediction-market alpha needs infrastructure

Three barriers stop retail from harvesting the signal.

- **Operational cost.** Riding prediction-market alpha continuously needs bots, monitoring, and 24/7 attention. Fine for a fund. Impossible for a solo depositor.
- **Missing risk management.** A directional signal without sizing, stops, and a hedge leg is a way to get liquidated by the same move you predicted.
- **Unverifiable AI.** "Our model is great" is the industry claim. Every AI-agent crypto product ships a black box; users are asked to trust a team.

The convergence that makes 2026 the moment: Polymarket has real liquidity, ZK-STARKs finally verify in sub-second on commodity hardware, and consumer on-chain UX (smart accounts, sponsored gas, one-click deposits) closes the last-mile gap. Bittensor, ASI Alliance, Fetch, and MyShell all crossed $1B market cap — the market has decided AI-managed workflows are the frontier. The open question is trust.

## What we do differently: predictive, not reactive

Traditional risk management reacts. The pattern is well-documented: an event fires, an alert lands, a human reviews, a decision is made, orders go in, settlement clears. The median time between event and settlement in a serious drawdown is 60–90 minutes. In four of the last five major crypto crashes, the majority of the drawdown was already visible in prediction markets 30–120 minutes before the price move.

| Event | Total drop | Loss before typical hedge | Pre-visible in prediction markets |
|---|---|---|---|
| March 2020 (COVID) | −50 % | −35 % | Yes — pandemic-spread contracts |
| May 2021 (China ban) | −53 % | −28 % | Yes — regulatory calendar contracts |
| Luna / UST (May 2022) | −99 % | −45 % | Yes — depeg contracts hit 0.85 hours prior |
| FTX (Nov 2022) | −25 % | −18 % | Yes — CZ withdrawal-tweet market |

ZKward inverts the loop. A 5-minute cron reads the aggregator, sizes the hedge, opens on BlueFin, verifies the fill via `getPositions()` delta, and commits a STARK proof. The decision path is 30 seconds end-to-end on a hit, and it fires on the signal — not on the price.

## Architecture, without the diagram

Four layers. Every capital-touching action passes through all four. Diagnostics can short-circuit at any layer.

1. **UI.** Next.js 16 App Router, React 19, Tailwind, 12-locale i18n. No wallet SDK on marketing pages (that bundle is lazy-loaded on /dashboard). PWA-registered.
2. **Agent orchestration.** Seven typed agents behind `SafeExecutionGuard`: single-trade cap $10M, daily cap $100M (UTC reset), 30 bps slippage ceiling, 4× leverage ceiling, 2-of-3 consensus threshold above $100K, 5-second cooldown, ZK proof hash stored for every execution above $1M.
3. **Data + integration.** Polymarket, Delphi, Manifold, Crypto.com prices, Pyth oracles, BlueFin (perps + funding), Kalshi (ATM strike), Deribit (implied vol), Binance and Bybit (funding + long/short + OI). 20-second TTL in a shared aggregator. Bakchodi PostgreSQL 18 for off-chain state.
4. **Blockchain.** SUI mainnet Move contracts (pool + hedge executor + STARK verifier + proxy vault) as the lead chain. Hedera testnet, Sepolia, Cronos EVM, Oasis Sapphire, Arbitrum Sepolia as multichain reference deployments.

### The seven agents

Lead (intent parse), Risk (VaR + Sharpe + drawdown), Hedging (fused-signal hedge ratio), Settlement (sponsored-gas 2-step), Reporting (proof-optional summaries), Price Monitor (cross-source sanity), and SUI Pool (signal reasoning for the community pool cron). Cron routes generally bypass agents for latency, with the SUI cron lazily instantiating `getSuiPoolAgent()`.

### Live contracts (SUI mainnet, v0.2.0)

- **Package:** `0x107292a69eea2f6eaf4a4e4727ee25d747b04c1985441b138933f0ef33f7b726`
- **Pool state:** `0xe814e0948e29d9c10b73a0e6fb23c9997ccc373bed223657ab65ff544742fb3a`
- **Capabilities:** `AdminCap` (currently hot, migrating to MSafe via the OracleCap split in v0.4.0), `FeeManagerCap` (MSafe), `OracleCap` (planned split; hot key attests NAV without touching pool authority).
- **TVL cap:** $10,000, enforced by the Move contract. Governance action required to lift.

Prior deployment (v0.1.0 at `0x9ccb…c88`) is dormant. The withdrawal-underpayment bug that motivated the v0.2.0 redeploy is fixed on-chain; reproduce via `bun run scripts/analyze-pool-pnl.ts`.

## Zero-knowledge, without hand-waving

The STARK backend is transparent. No trusted setup, no elliptic curves, no discrete-log assumptions.

- **Field.** Goldilocks prime `p = 2^64 − 2^32 + 1 = 18446744069414584321` (same field as Polygon zkEVM and Plonky2), primitive root `g = 7`. Native 64-bit arithmetic; fast NTT.
- **Soundness.** Per FRI Theorem 1.2 (Ben-Sasson–Bentov–Horesh–Riabzev, ePrint 2018/828), `ε ≤ ρ^q`. We configure `ρ = 1/4` and `q = 80`, giving `ε = 2^(−160)`. Add 20 bits of proof-of-work grinding: `2^(−180)` total, 52 bits above NIST Post-Quantum Level 1. Hedge proofs use 24-bit grinding and 16× blowup for a bit more headroom.
- **Non-interactivity.** Fiat–Shamir over SHA-256 in the random-oracle model.
- **CUDA prover for self-hosted operators.** GPU-optimised NTT via CuPy/Numba, probe-verified on import. Vercel deployment has no GPU, so production runs the CPU-only prover.

Enforced end-to-end at every FRI layer: value + sibling Merkle binding; folding-consistency `f_{L+1}(x²) = (v+s)/2 + α·(v−s)/(2x)` over the multiplicative coset; Fiat–Shamir challenges bound to `sha256(root_L)`; final-polynomial degree bound.

### What a hedge proof commits

```
Commitment hash — 146-byte SHA-256 preimage, fixed binary layout
  version_u32BE                      (4)
  portfolioId_u32BE                  (4)
  timestampMs_u64BE                  (8)
  asset_code_u8                      (1)   BTC=1, ETH=2, SUI=3
  side_code_u8                       (1)   LONG=0, SHORT=1
  leverageX_u32BE                    (4)
  leverageCap_u32BE                  (4)
  entryPriceUsdcCents_u64BE          (8)
  sizeUnits_u64BE                    (8)   per-asset step units
  notionalValueUsdcCents_u128BE      (16)
  notionalCapUsdcCents_u128BE        (16)
  salt_32B                           (32)
  inputsHash_32B                     (32)  SHA-256 of canonical JSON
```

On-chain verification: `zk_verifier::verify_hedge_stark_proof_entry` → grinding PoW check (≥ 20 bits, 24 for hedge) → FRI (Merkle + folding-consistency + Fiat–Shamir) → composition polynomial identity for asset / side / leverage → replay protection via `used_proofs`.

The whole binding path is SHA-256. No elliptic curves, no pairings — Shor's algorithm is a non-threat. The legacy ed25519 fast path can be disabled by an admin via `admin_set_stark_only_mode(true)`, forcing every verify through the post-quantum STARK path.

### What's checked, and what isn't

| Property | Reference | Verification | Status |
|---|---|---|---|
| Transparency (no trusted setup) | ePrint 2018/046 Def 1.1 | All parameters are public constants | ✓ |
| Post-quantum | 2018/046 §1.1 | No DLP or factoring; SHA-256 only | ✓ |
| FRI soundness | 2018/828 Thm 1.2 | `ε = ρ^q = 2^(−160)`; with grinding, `2^(−180)` | ✓ |
| Zero-knowledge | 2018/046 Def 1.3 | Witness hidden; proof reveals nothing | ✓ |
| Completeness | 2018/046 Def 1.2 | Valid witness → valid proof (68/68 Python STARK tests) | ✓ |
| Soundness (empirical) | this repo | 16 tamper vectors, all rejected | ✓ |
| Hedge invariants (AIR-in-STARK) | this repo, 2026-07 | Asset / side / leverage constraints in the composition polynomial, verified on-chain | ✓ |

**Honest scope note.** Empirical soundness harness (`python zkp/tests/empirical_soundness_harness.py`) confirms round-trip success and tamper-vector rejection on the inputs we tried. That is a necessary signal, not a machine-checked formal proof. A full Coq / Lean encoding of the STARK protocol is out of scope for this repo. External audit (SUI Foundation grant milestone T4-C) is where the formal review lives.

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

Every destructive action is env-gated. Rollout is deliberately staged: log-only first, flip execution one gate at a time (`PORTFOLIO_DRIVER_EXECUTE` → `STALE_HEDGE_AUTO_CLOSE` → `ALERT_RESPONSE_EXECUTE` → `ALERT_RESPONSE_EXECUTE_HALT`) after 24 hours of clean logs. `bun jest test/integration/pool-drawdown-defense.test.ts` stays green through every merge — that test is the operational contract.

## Signal fusion

Ten sources feed the aggregator, each with a fixed weight and a 20-second TTL. Weights are per-asset; the table below is BTC.

| Source | BTC weight | Cadence | Notes |
|---|---|---|---|
| Polymarket 5-min BTC | 30 % | 5 min | Chainlink-resolved, >90 % historical accuracy on 5-min horizon |
| Delphi | 5–15 % | 5 min | Medium-term outlook |
| Crypto.com price momentum | 20 % (BTC) / 10 % (ETH) | 30 s | 24h delta |
| BlueFin funding | 10 % | 60 s | Sentiment via funding sign |
| Binance funding + long/short | 12 % + 10 % | 60 s | Contrarian: funding > +0.005 %/8h → SHORT bias |
| Bybit funding + OI change | 8 % + 5 % | 60 s | Cross-venue confirmation |
| Kalshi ATM strike | 15 % | 5 min | Regulated US prediction contract |
| Deribit realized vol | filter | 60 s | Below 40 % annualized → skip trade |
| Multi-asset alignment | dynamic | derived | STRONG upgrade when multiple sources agree |

Hedge ratio is 50 % of exposure (100 % for pools under $1K), scaled by a confidence multiplier `1 + (probability − 0.5) × 0.5`, then clamped by on-chain `max_hedge_ratio_bps`. Example: a 73 % probability signal → 1.23× multiplier → `50 % × 1.23 = 61.5 %` exposure hedged.

### The small-NAV asymmetry

BlueFin's per-symbol minimum size creates a hedgeability gap at small NAV: BTC-PERP min 0.001 (~$73), ETH $30, SUI $4. When `allocation × NAV < floor`, the perp leg is skipped — leaving spot naked-long even under a BEARISH signal. Gate 3 in the defense table redirects that allocation to USDC; `PortfolioDriver` actively unwinds the pre-existing spot instead of documenting the exposure.

## Multi-chain

SUI is the lead chain by design. Other chains are proven at testnet level so pool logic can migrate when demand justifies it. The multi-chain surface is a capability, not a scattered focus.

| Chain | Role | Status |
|---|---|---|
| **SUI Mainnet** | Lead — pool, hedge executor, STARK verifier | ✅ Live (v0.2.0) |
| Cronos EVM | Multi-chain reference; x402 gasless research | ✅ Deployed |
| Oasis Sapphire | Confidential-EVM primitive validation | ✅ Testnet |
| Arbitrum Sepolia | L2 pool + hedge reference | ✅ Testnet |
| Hedera Testnet | Non-EVM performance validation, HCS audit topic, GraphQL adapter (npm-published) | ✅ Testnet |

## Security

**Contracts.** OpenZeppelin where EVM applies; Move code uses `sui::` with explicit `entry` boundaries. 15 internal audit phases completed (2026-06-04 through 2026-06-12); external audit is a SUI Foundation grant deliverable (T4-C).

**Cryptographic.** 180-bit effective STARK soundness (80 FRI queries × 20-bit grinding). SHA-256 Merkle trees, 10-layer FRI hierarchy. Goldilocks field. ECDH stealth addresses for private hedges. `admin_set_stark_only_mode(true)` forces post-quantum-only verification.

**Operational.** Non-custodial — the pool holds capital under Move object custody, not admin authority. Every cron uses `verifyCronRequest` + `tryClaimCronRun` (idempotency) + `setCronState` (heartbeat). Missing heartbeats trip alerts within one interval. Every capital-moving action fires a Discord alert and appends to `alert-log:ring-buffer`. Reconcilers cross-check on-chain Move ↔ BlueFin (hourly) and BlueFin ↔ DB (every 15 min). Pre-push hook runs the security scan on every push.

**Kill switches.** `SUI_AUTO_HEDGE_DISABLE=1` (halt), `HEDGE_MIN_NAV_USD` (default 20; hedge blocked below), `NAV_SAFETY_CEILING_USDC` (default 10B; halts writes above ceiling; Move u128 redeploy required before scaling past it).

## Economics

**Revenue on-chain.** 50 bps annual management + 10 % performance on realised profits. Routed through `FeeManagerCap` (MSafe multisig). `AdminCap` (currently hot, migrating to MSafe via OracleCap split) is a separate object — the fee path cannot be sacrificed to an admin key compromise.

**Revenue off-chain.** Subscription access to private hedges and the private portfolio creator. Consumer flow proves the ZK rails; subscription flow prices them.

**Capital state.** $10K contract-enforced TVL cap. Cap-lifting is a governance action (`sui-set-tvl-cap`, `CRON_SECRET`-gated), not a code change. `NAV_SAFETY_CEILING_USDC` default 10B halts writes above ceiling; scaling past requires the Move u128 redeploy.

**Cost.** Vercel `sin1` (Bangalore) for API + crons; pay-per-request, dominated by cron cadence and function memory. Bakchodi self-hosted PostgreSQL 18 via PgBouncer. Self-hosted job scheduler (jobs.zkward.com) — we moved off Upstash QStash 2026-09-19 for cost and latency.

Growth projections are omitted deliberately. The whitepaper describes what runs today, not a forecast.

## Roadmap

| When | What | Status |
|---|---|---|
| Q1 2026 | Cronos EVM (Moonlander, VVS, x402); STARK cutover to `CUDATrueSTARK` | ✅ |
| Q2 2026 | SUI mainnet pool v0.1.0 → v0.2.0; withdrawal-underpayment fix; TVL cap enforcement; multichain reference deploys | ✅ |
| Q3 2026 | v0.3.0 autonomy defense (8 gates); regret tracker; refactor arc (2,087 LOC → 15 pure modules); Aiven → Bakchodi migration | ✅ |
| Q4 2026 (current) | External audit (SUI Foundation grant T4-C); OracleCap split (v0.4.0) so AdminCap → MSafe fully; TVL cap raise post-audit | 🔧 |
| 2027+ | Cross-chain unified portfolio; Cronos zkEVM enhanced privacy path; expanded prediction sources | 📋 |

## Conclusion

ZKward is a live vault, not a pitch deck. Prediction-market alpha, seven typed agents, an eight-gate defense system, a $10K contract-enforced cap during the operational-proof phase, and a STARK proof for every hedge decision. Cap-lifting is a governance action, not a code change. Ship what runs today.

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
