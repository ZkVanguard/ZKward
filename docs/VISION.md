# Vision — Where ZKward is going

> **Today:** AI-managed Polymarket-alpha vault on Sui mainnet.
> **Trajectory:** Autonomous, transparent, programmable asset management on Sui.
> **North star:** The Aladdin-equivalent + iShares-equivalent for Web3 — a multi-product asset manager built on the first privacy-preserving DeFi infrastructure on Sui.

This document is a roadmap, not a marketing slogan. Each waypoint is concrete code work using primitives that are already shipped or have a defined design path. We deliberately do not claim the destination as the present state.

---

## Today (verifiable on-chain, 2026-06-29)

- **Live mainnet:** v0.2.0 deployed 2026-06-12 ([Suiscan](https://suiscan.xyz/mainnet/object/0x107292a69eea2f6eaf4a4e4727ee25d747b04c1985441b138933f0ef33f7b726))
- **NAV / share price:** $57.32 / $1.8973 (ATH $1.9091, within 0.6%)
- **Capital-flow PnL:** +$26.52 (+86.1%) on $30.80 lifetime deposits
- **Three live products** on shared infrastructure: SUI USDC Community Pool · Private Hedges · Private Portfolio Creator
- **80-100 distinct shipped capabilities** across risk engine, fund products, settlement, reporting, compliance, distribution, agent orchestration, ZK proofs, multi-chain footprint (see codebase audit)
- **First privacy-preserving DeFi infrastructure on Sui mainnet** — 1,713 LOC of audit-reviewed Move (`zk_hedge_commitment` + `zk_proxy_vault` + `zk_verifier`) + ~7K LOC Python STARK prover (NIST P-521)
- **TVL deliberately capped at $10K** in `community_pool_usdc.move` via contract-enforced strict mode — operational proof, not a TVL claim, pending external audit

## What "BlackRock for Web3" actually means in our scope

BlackRock's competitive moat is *not* the assets it holds. It's three things:

1. **Aladdin** — unified risk engine that 200+ external asset managers pay to use ($1B+ ARR)
2. **iShares fund family** — multi-product surface (ETFs across asset classes), one shared operational backbone
3. **Trust posture** — board governance, audit, compliance, regulated wrapper, fiduciary discipline

We are not claiming to replicate BlackRock's $10T AUM, its regulated-investment-advisor status, or its multi-asset-class breadth (equities, bonds, alternatives, commodities). The phrase **"BlackRock for Web3"** in ZKward's context means specifically:

> **An autonomous, transparent, programmable asset-management platform on Sui — where the risk engine, fund family, and trust posture are productized into one infrastructure stack that ZKward runs its own funds on AND sells as B2B SDK to other Sui builders.**

That framing is defensible because each component maps to shipped code.

| BlackRock pillar | ZKward mapping | Status |
|---|---|---|
| **Aladdin (risk engine)** | `SafeExecutionGuard` + `ProductionGuard` + `PriceCircuitBreaker` + `LiquidationGuard` + `PositionRiskScorer` + `HedgeRiskMath` + multi-agent consensus | ✅ Shipped, per-product. Platform-wide aggregation = Phase 2. |
| **iShares (fund family)** | 3 live products (Community Pool · Private Hedges · Private Portfolio) on shared engine. Multi-pool variants = Phase 3. | ✅ 3 of N |
| **Trust posture** | 48h timelock · OFAC geo-block · MSafe-held FeeManagerCap · 15 internal audits · ed25519 prover attestation · external audit pending | ⚠ Partial — AdminCap still hot, external audit pending |
| **Open APIs (Aladdin B2B moat)** | 50+ existing internal API routes ready to be wrapped with auth + metering | ⚠ Endpoints exist, productization = Phase 4 |
| **Multi-asset class** | Crypto + perps only today | ❌ Future — requires real-world asset oracles + custody attestation primitives |
| **Regulated wrapper** | None — permissionless DApp | ❌ Future — requires legal/regulatory work, not just code |

The honest reading: **technical architecture is ~80% there. The gap is regulatory + custody + scale, not engine.**

---

## Roadmap — concrete waypoints with shipped-code prerequisites

### Phase 1 — Unified portfolio view ✅ SHIPPED (2026-06-28)

`/dashboard/overview` + `/api/portfolio/unified?wallet=…`

A single wallet's exposure across all products (pool position + pro-rata hedge exposure + ZK-owned hedges + EVM portfolios) aggregated into one investor-facing view. The "consolidated statement" model that BlackRock clients expect.

Files: `app/api/portfolio/unified/route.ts`, `app/[locale]/dashboard/overview/page.tsx`

### Phase 2 — Investor-facing risk dashboard (next, ~2 days)

`/dashboard/risk` — public-facing version of `/api/health/production`:

- Total platform TVL across all funds
- Drawdown / Sharpe per fund
- Hedge coverage ratio
- ZK attestation feed (last 50 risk decisions with proof hashes)
- Peer comparison vs Polymarket signal

Data already exists (ReportingAgent generates it). Phase 2 is the UI layer.

### Phase 3 — Multi-pool fund family (~1 week)

`community_pool_usdc.move` is already template-shaped. Deploy N instances with different mandates served by the same 7-agent orchestrator:

- **Core Allocation Fund** (today's pool) — balanced BTC/ETH/SUI
- **High-Yield Vault** — aggressive Polymarket alpha
- **Conservative Vault** — majority stables, small directional exposure
- **Sector vaults** — DeFi-only, L1-only

The agent only needs `pool_id` as input — orchestration logic is reusable.

### Phase 4 — Risk-engine-as-a-Service / open API productization (~1 week)

Wrap 5 high-value existing API routes with API-key auth + Stripe metering:

- `POST /api/risk/evaluate` — submit hypothetical trade, get risk assessment + ZK proof
- `POST /api/agents/consensus` — ask 7-agent system to vote on strategy
- `POST /api/zk/attest` — STARK proof for any computation
- `POST /api/predictions/aggregated` — fused per-asset prediction signal
- `POST /api/hedge/route` — best-execution multi-venue perp router

These endpoints exist as internal calls. Productizing them is the actual B2B moat — "Aladdin-as-a-Service" for any Sui DEX, vault, treasury, or RWA tokenizer.

### Phase 5 — Custody attestation primitive (~50h, post-Tranche-1)

New Move contract `rwa_custody_attestor.move` (~250 LOC) that extends the existing ed25519 prover system. Enrolled institutional custodians sign attestations binding `(portfolio_id, asset_list, nonce)`. Lets a wallet prove off-chain backing without revealing what it holds.

This is the first primitive that bridges into RWA territory. Not "RWA platform" yet — but the foundation that any institutional partner needs before tokenizing real-world assets into a ZKward pool.

### Phase 6 — Regulated wrapper (legal, 6-12 months)

Reg A+/D registration, broker-dealer or RIA structure, KYC partner (Persona/Sumsub) integration, custody bank partnership. This is the gate to actually claiming multi-asset class + institutional capital. Code work is secondary to legal work.

### Phase 7 — Multi-asset class (12-18 months)

First real-world-asset oracle adapter (Pyth/Switchboard for T-bill yields, gold spot, FX). Tokenized real-world asset integration (Ondo USDY or similar partner). Now the **"BlackRock for Web3"** claim earns itself because the platform actually holds multi-asset exposure with custody attestation, regulated wrapper, and the Aladdin-style risk engine that's been in production for 18 months.

---

## What we ARE today (defensible claims)

- The **first privacy-preserving DeFi infrastructure** on Sui mainnet (1,713 LOC of zk_* contracts)
- An **autonomous AI-managed crypto vault** with 7-agent consensus + ZK risk attestation
- A **multi-product platform** with three live products on shared infrastructure
- An **audit-hardened Move stack** with 15 internal audit phases and external audit pending
- A **prediction-market-driven allocation engine** — Polymarket alpha as gated primary signal, no other Sui project does this

## What we ARE NOT today (and won't claim until we are)

- A regulated investment advisor or fund
- A custodian of real-world assets
- A multi-asset platform (crypto + perps only)
- An ETF issuer
- A KYC-gated institutional venue
- "BlackRock for Web3" in the present tense (only as trajectory)

---

## Why this framing matters for the grant

A reviewer who clicks our GitHub and finds "BlackRock for Web3" in our marketing would reasonably ask: *show me where the regulated wrapper is, where the multi-asset exposure is, where the custody attestation is*. They'd find none of those, lose trust, and the application dies on credibility.

A reviewer who clicks into this VISION.md sees the **trajectory mapped to concrete waypoints with shipped-code prerequisites**, with each phase honestly labeled by status. That earns trust. The grant funds the bridge from where we are to where the trajectory is going.

Last updated: 2026-06-29
