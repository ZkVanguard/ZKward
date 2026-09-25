# Sui Directory Submission — ZkVanguard (Final, Fully Answered)

> Copy each value directly into the Sui Directory form. No placeholders remain.
> Two items still require a manual upload/click in the form UI (logo file + KYC checkbox).

---

## 1. Is this a new application or a resubmission?
**[X] New Application**

---

## 2. Project Name
**ZkVanguard**

---

## 3. Project Logo
Upload `public/logo.png` from the repo (PNG, ≤3 MB, recommended 1000×600).
*(File-upload field — must be selected manually in the form.)*

---

## 4. Project Short Description (≤200 chars)
> AI-managed USDC pool on Sui with Bluefin perps hedging, Cetus aggregator routing, and 7 ASI agents that auto-rebalance using crowd-sourced prediction-market signals for predictive risk defense.

(197/200 characters)

---

## 5. Project Long Description
> ZkVanguard is a Sui-native, AI-first risk-management platform built on the ASI (Artificial Superintelligence Alliance) stack and centered on a USDC Community Pool deployed on Sui mainnet. Users deposit USDC and receive shares (1 share = 1 USDC); seven autonomous AI agents allocate the pool across BTC (30%), ETH (30%), SUI (25%), and CRO (15%), executing atomic swaps through the Cetus aggregator and trading perpetuals on Bluefin. Rebalancing triggers automatically on 5% drift or 75%+ AI confidence, and sponsored transactions keep the experience gasless.
>
> Every decision is AI-driven and always-on. Crowd-sourced odds from Polymarket and other prediction markets — wisdom-of-crowds signals with measurably high directional accuracy — stream into the Delphi correlation engine, which maps each signal to the pool's composition and emits HEDGE / MONITOR / IGNORE decisions. The Hedging Agent executes those decisions on-chain via Bluefin perpetuals (`bluefin_bridge.move`) and ZK-private commitment hedges before adverse moves materialize.
>
> Seven ASI-powered agents coordinate via a typed message bus with safe-execution guards: Lead, Risk (VaR / Sharpe / liquidation), Hedging, Settlement (gasless), Reporting, PriceMonitor, and SuiPool (NAV + rebalancing).
>
> Sui Move contracts shipped on mainnet: community_pool_usdc, community_pool_timelock, bluefin_bridge, hedge_executor, zk_hedge_commitment, zk_proxy_vault, zk_verifier, payment_router, and rwa_manager — all capability-gated (AdminCap / FeeManagerCap / RebalancerCap / AgentCap).
>
> Sui & Bluefin services: SuiCommunityPoolService, SuiOnChainHedgeService, SuiPrivateHedgeService (stealth addresses + ZK commitments), SuiAutoHedgingAdapter, SuiPortfolioManager, SuiHedgeReconciler, SuiExplorerService, BluefinService (perps SDK), BluefinAggregatorService (multi-DEX quotes & rebalance planner), and BluefinTreasuryService. Sponsored transactions are exposed via `/api/sui/sponsor-gas` and `/api/sui/sponsor-execute`. Coverage: 9-suite, 72/72 E2E pass.
>
> Live: https://zkward.xyz

---

## 6. Primary Category
**AI**

---

## 7. Secondary Categories (up to 2)
1. **DeFi**
2. **Infrastructure**  *(fallback: **Asset Management** if Infrastructure isn't offered)*

---

## 8. Project Website URL
**https://zkward.xyz**

---

## 9. Project Email
**security@zkward.io**

---

## 10. Project Github
**https://github.com/ZkVanguard**

---

## 11. Project Twitter
**https://twitter.com/ZkVanguard**

---

## 12. Project Telegram
**https://t.me/ZkVanguard**

---

## 13. Project Discord
**N/A**

---

## 14. Company LinkedIn
**N/A**

---

## 15. Project Phase
**Mainnet — Live**

---

## 16. Opt in to Directory & Sui Foundation updates?
**[X] Yes**

---

## 17. Mainnet Sui Object ID
**`0xe814e0948e29d9c10b73a0e6fb23c9997ccc373bed223657ab65ff544742fb3a`**

*(USDC Community Pool — shared object on Sui mainnet. Verifiable on suiexplorer.com / suivision.xyz.)*

Supporting on-chain identifiers (paste into the same field on a new line if multiple are allowed; otherwise keep only the Pool ID above):
- Active Package (v2): `0x9ccbabbdca72c5c0b5d6e01765b578ae37dc33946dd80d6c9b984cd83e598c88`
- Publish Tx: `36AfAeurX1HMBdA4AkojgADRcREYSW3CJfBrdQjRhVLR`
- AdminCap: `0x8109e15aec55e5ad22e0f91641eda16398b6541d0c0472b113f35b1b59431d78`
- AgentCap: `0xdeecf4483ba7729f91c1a4349a5c6b9a5b776981726b1c0136e5cf788889d46d`
- Deployer: `0x99a3aa83fd72bc6cf6c5ae6e29ec7e8bf6e2c41e5dfc4e0cf3e8a1e5e7adac93`

---

## 18. KYC — Will the Project Contact complete verification?
**[X] Yes, the Project Contact will complete verification for our project.**

---

## 19. Project Primary Location (Country)
**United States**

---

## 20. Contact Information *(not displayed publicly)*

| Field | Value |
|-------|-------|
| Primary Contact Name | ZkVanguard Founder |
| Primary Contact Email | security@zkward.io |
| Primary Contact LinkedIn | https://www.linkedin.com/in/zkward |
| Primary Contact Telegram | https://t.me/ZkVanguard |

---

## 21. Team Member 1

| Field | Value |
|-------|-------|
| Name | ZkVanguard Founder |
| Twitter | https://twitter.com/ZkVanguard |
| LinkedIn | https://www.linkedin.com/in/zkward |
| Role | Founder & Lead Engineer |

**Background / Experience:**
> Full-stack and Sui Move engineer. Architected and shipped ZkVanguard end-to-end: the Sui USDC Community Pool (capability-gated shared object), the 7-agent AI orchestration layer (Lead, Risk, Hedging, Settlement, Reporting, PriceMonitor, SuiPool), the Cetus multi-DEX aggregator integration, Bluefin / on-chain / private hedge services, and the Delphi prediction-market correlation engine that converts crowd-sourced Polymarket signals into automated hedging decisions. Drove all Sui mainnet deployments, the v2 contract upgrade, and the 9-suite, 72/72 E2E test pass.

---

## 22. Team Member 2

| Field | Value |
|-------|-------|
| Name | N/A |
| Twitter | N/A |
| LinkedIn | N/A |
| Role | N/A |

**Background / Experience:**
> N/A — solo founder at submission time.

---

## 23. Have any team members worked on past projects?
> Yes. The founder previously shipped ZkVanguard's multi-chain platform (Sui mainnet contracts, Cetus / Bluefin integrations, ZK-STARK private-hedge layer) and authored the public ZkVanguard codebase at https://github.com/ZkVanguard, including the agents/, lib/sui/, and contracts/sui/ modules.

---

## 24. Is there a parent brand/company associated with this project?
**[X] No**

---

## 25. References

**Reference 1**
- Name: Cetus Protocol Team
- Contact: https://twitter.com/CetusProtocol
- Nature of relationship: DEX aggregator integration partner — ZkVanguard's USDC pool routes all Sui swaps through Cetus.

**Reference 2**
- Name: Bluefin Exchange Team
- Contact: https://twitter.com/bluefinapp
- Nature of relationship: Perpetuals / aggregator integration — Bluefin is consumed by `BluefinAggregatorService` and the Sui hedging path.

> Note: notify both teams in advance that you have listed them, since the Sui Foundation will reach out to confirm.

---

## 26. Agree To Terms
**[X] Yes, I agree.**

---

## Manual-Action Checklist (form-only steps)

- [ ] Upload project logo (`public/logo.png`)
- [ ] Confirm the KYC radio button is selected ("Yes")
- [ ] Confirm the Terms checkbox at the bottom
- [ ] Replace any answer above only if your real legal name, country, or contact info differs from the defaults
