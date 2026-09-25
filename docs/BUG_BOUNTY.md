# Bug bounty

> **Paused — external audit in progress (as of 2026-09-25).**
>
> Payouts resume after the audit closes and the recommended mitigations
> ship. During the pause we still triage and acknowledge every report.
> Critical findings that would let an attacker move user capital get paid
> retroactively once the program reopens — file them anyway via the
> [security policy](./SECURITY.md).

## Scope

**In scope**

- Mainnet Move contracts under package
  `0x107292a69eea2f6eaf4a4e4727ee25d747b04c1985441b138933f0ef33f7b726`
- Public API endpoints at `zkward.com/api/**`
- Off-chain defense stack (verified by
  `test/integration/pool-drawdown-defense.test.ts`)
- ZK-STARK prover in `zkp/`
- Web-frontend authentication and signature flows

**Out of scope**

- Testnet contracts on any chain
- Third-party services we depend on (BlueFin, Polymarket, Crypto.com —
  report to those vendors directly)
- Development branches
- Social engineering of operators, phishing of users
- DoS attacks that require legitimate protocol participation

## Reporting

1. Email `ashishregmi2017@gmail.com` with subject prefix `[security]`
2. Include affected component, reproduction steps, impact analysis
3. Do not disclose publicly before we respond
4. Acknowledgment within 48 hours

## Safe harbor

We will not pursue legal action against researchers who:

- Avoid privacy violations, destruction of data, and service interruption
- Only interact with accounts they own or have explicit permission for
- Give reasonable time to fix before public disclosure
- Do not exploit beyond what is necessary to demonstrate the issue

## Disclosure timeline

- Day 0 — report received
- Day 0–2 — acknowledgment + initial triage
- Day 2–5 — severity classification confirmed
- Day 5–N — fix deployed
- Day N+30 — public disclosure with attribution

Critical issues with active exploitation risk hold disclosure until the fix
is live on mainnet.

---
Last updated: 2026-09-25
