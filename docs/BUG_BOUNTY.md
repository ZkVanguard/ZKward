# Bug Bounty Program

ZKward runs a continuous bug bounty for security researchers and white-hat
hackers. We pay for verified, reproducible vulnerabilities in our deployed
mainnet contracts and the production infrastructure that touches user capital.

> **Grant note:** This bug bounty is a Tranche 2 deliverable of the SUI Foundation
> grant. The bounty pool scales with TVL — see the payout table below.

## In scope

### Mainnet Move contracts (Sui)

Package: `0x107292a69eea2f6eaf4a4e4727ee25d747b04c1985441b138933f0ef33f7b726`

- `community_pool_usdc.move` — USDC vault, NAV oracle, share accounting
- `zk_hedge_commitment.move` — stealth addresses, nullifiers, commitment storage
- `zk_proxy_vault.move` — PDA-style proxies, time-locked withdrawals, ZK ownership
- `zk_verifier.move` — STARK proof verification, ed25519 prover attestation
- `payment_router.move` — fee routing
- `community_pool_timelock.move` — 48h admin operation delay
- `hedge_executor.move` · `bluefin_bridge.move` — perp settlement glue

### Production infrastructure

- Public API endpoints at `zkward.com/api/**`
- All active cron routes (see `docs/MAINNET_READINESS.md § Scale & Security Hardening`) — gating logic, signature verification, rate limits, cron_state halt flags
- **v0.3.0 8-gate autonomy defense stack** — `PortfolioDriver`, `HedgeFillVerifier`, `StaleHedgeDetector`, `applyHedgeabilityClamp`, `regret-tracker`, `alert-response-loop`, phantom-rate detection at `/api/health/production`. Bypass or corruption of any gate is in scope.
- Off-chain ZK-STARK prover (`zkp/` Python backend)
- Web frontend authentication + signature flows
- Halt-flag write path (`polymarket-edge:halted-until` for HALT_TRADER; `cron:haltUntil:sui-community-pool:autohedge` + `cron:haltReason:sui-community-pool:autohedge` for HALT_AUTOHEDGE via `setCronHalt`) and alert-log ring buffer (`alert-log:ring-buffer`) — griefing via halt-flag manipulation is in scope at Medium tier

## Out of scope

- Testnet contracts (Cronos / Hedera / Oasis / Sepolia)
- `rwa_manager.move` — generic primitive not in any user flow
- Third-party services we depend on (BlueFin, Polymarket, Crypto.com — report
  directly to those vendors)
- Issues already disclosed in `docs/AUDIT_*.md` internal audit reports
- Bugs in development branches
- DoS attacks that require participating in the protocol legitimately
  (e.g. spamming deposits at $0.01 — rate-limit handled at app layer)
- Phishing of users, social engineering of operators
- Issues in libraries we vendor unless they're exploitable through our usage

## Payout tiers

Bounties scale with severity, with the **pool funded at 1% of platform TVL with
a $500 floor**:

| Severity | Definition | Payout (current TVL ≈ $57) | Payout at $50K TVL | Payout at $1M TVL |
|---|---|---|---|---|
| **Critical** | Direct theft of user funds, drain of pool, infinite mint of shares, bypass of capability gates | $500 (floor) | $500 (floor) | $10,000 |
| **High** | Significant loss vector (NAV manipulation, oracle injection, ZK proof forgery, fee diversion) | $500 (floor) | $500 (floor) | $5,000 |
| **Medium** | Logic bug that violates a documented invariant but doesn't move funds (drawdown halt bypass, MEV leak, stale data exposure) | $250 | $250 | $1,000 |
| **Low** | Spec violation, doc-mismatch, gas inefficiency, defense-in-depth gap | Acknowledgement + hall-of-fame | Acknowledgement | $250 |

The floor matters: even at $57 TVL we honor at least $500 for critical/high to
make the program meaningful to researchers from day one.

## Reporting process

1. **Email** `ashishregmi2017@gmail.com` with subject prefix `[security]`
2. **Include:**
   - Affected component (contract name + function, or API path)
   - Step-by-step reproduction (working PoC strongly preferred)
   - Impact analysis (what an attacker can do, who's affected)
   - Suggested mitigation (optional)
3. **Do not** open public GitHub issues, post on X/Telegram, or otherwise
   disclose publicly before we've responded
4. We acknowledge within **48 hours**
5. Critical/high issues: we coordinate a fix + disclosure timeline within
   **5 business days**

## Safe harbor

We will not pursue legal action against researchers who:

- Make a good-faith effort to avoid privacy violations, destruction of data,
  and interruption of service
- Only interact with accounts they own or with explicit permission of the
  account holder
- Provide us reasonable time to fix before public disclosure
- Don't exploit the vulnerability beyond what's necessary to demonstrate
  the issue

## Disclosure timeline

- **Day 0:** Report received
- **Day 0-2:** Acknowledgement + initial triage
- **Day 2-5:** Severity classification + payout amount confirmed
- **Day 5-N:** Fix deployed (timeline depends on severity + complexity)
- **Day N+30:** Public disclosure (CVE if applicable, attribution to reporter)
- Critical issues with active exploitation risk: disclosure delayed until fix
  is live on mainnet

## Hall of fame

(Reporters who've helped harden the platform — populated as reports come in.)

| Researcher | Date | Issue | Severity |
|---|---|---|---|
| _Your name could be here_ | — | — | — |

## Why bug bounty matters for ZKward

- We hold real user capital (currently $57, capped at $10K, growing post-audit)
- Our risk engine and ZK attestation infrastructure are positioned as B2B SDK
  for other Sui builders — bugs we miss could cascade
- The external audit (Tranche 1 deliverable) is a snapshot; bug bounty is
  continuous coverage
- Sui Foundation grant reviewers explicitly look for "credible security
  program" — internal audits + external audit + bug bounty + reporting
  cadence is the trio

Last updated: 2026-07-18
