# Roadmap

Cap ratchets are contract-gated via `admin_set_tvl_cap` and unlock only
against a specific evidence bundle — not aspirational.

## Shipped

- **v0.1.0** (Jan 2026) — beta with the 5-agent orchestrator, ZK-STARK
  privacy layer, and x402 gasless settlement on Cronos testnet
- **v0.2.0** (Jun 2026) — SUI mainnet USDC pool, external NAV oracle,
  contract-enforced TVL cap, 15 internal audit phases
- **v0.3.0** (Jul 2026) — 8-gate autonomy defense stack, verified by
  `test/integration/pool-drawdown-defense.test.ts`
- **v0.4.x** (Aug–Sep 2026) — defense gates default-on, prediction
  aggregator overhaul, hedging-agent integration

## In progress

- External audit close
- TVL cap ratchet against external-audit sign-off
- Dashboard risk-overview enhancements

## Planned

- Multi-venue perp hedging beyond BlueFin
- Institutional tier via `rwa_custody_attestor.move`
- Multi-chain expansion (chain selection driven by partner demand, not
  roadmap gates)

## Not planned

- Own DEX or perp venue — we route through third-party venues
- Public token sale — TGE is utility-first if it happens
- KYC-gated retail deposits — the vault is permissionless above the
  geo-block layer; institutional tier is opt-in KYC
- Cross-chain bridge protocol — we deploy per-chain

---
Last updated: 2026-09-25
