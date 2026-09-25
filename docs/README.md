# ZKward Documentation

Living reference for the platform. All docs listed here are under active maintenance — historical / point-in-time material has been moved to [`docs/history/`](./history/) or removed.

## Start here

- **[Main README](../README.md)** — product overview, safety, roadmap, FAQ
- **[ARCHITECTURE.md](./ARCHITECTURE.md)** — system design overview
- **[DEPLOY_RUNBOOK.md](./DEPLOY_RUNBOOK.md)** — env conventions, invariants, admin endpoints, incident response

## Core reference

| Doc | Purpose |
|---|---|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | System design across TS / Move / Python |
| [DEPLOY_RUNBOOK.md](./DEPLOY_RUNBOOK.md) | Incident response, env presets, BlueFin invariants, admin endpoints |
| [MAINNET_READINESS.md](./MAINNET_READINESS.md) | Current mainnet posture, cap-lift criteria |
| [SUI_DEPLOYMENT.md](./SUI_DEPLOYMENT.md) | SUI-specific deploy runbook + object IDs |
| [SECURITY.md](./SECURITY.md) | Responsible disclosure, defense posture |
| [ROADMAP.md](./ROADMAP.md) | Cap-ratchet milestones |
| [CHANGELOG.md](./CHANGELOG.md) | Versioned release history |
| [SLO_AND_RUNBOOKS.md](./SLO_AND_RUNBOOKS.md) | Service objectives, cron incident runbooks |
| [SCALABILITY_ANALYSIS.md](./SCALABILITY_ANALYSIS.md) | Hard walls at $50M / $500M / $1B TVL |
| [BUG_BOUNTY.md](./BUG_BOUNTY.md) | Bounty tiers and scope |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | Contribution workflow |
| [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) | Contributor code of conduct |
| [SETUP.md](./SETUP.md) | Local setup |

## Product + protocol specs

- [CUSTODY_ATTESTATION_SPEC.md](./CUSTODY_ATTESTATION_SPEC.md) — RWA custody attestation primitive
- [FORMAL_STARK_VERIFICATION.md](./FORMAL_STARK_VERIFICATION.md) — STARK protocol formal verification
- [INTERNAL_AUDIT_PACKET.md](./INTERNAL_AUDIT_PACKET.md) — invariants + hot spots for external audit review
- [VISION.md](./VISION.md) — product vision
- [INVESTOR_PITCH_DECK.md](./INVESTOR_PITCH_DECK.md) — investor deck

## Guides

- [guides/HEDGE_FUND_MANAGER_DECISION_FLOW.md](./guides/HEDGE_FUND_MANAGER_DECISION_FLOW.md) — hedge-fund workflow
- [guides/TESTNET_DEMO_GUIDE.md](./guides/TESTNET_DEMO_GUIDE.md) — testnet demo flow
- [guides/X402_GASLESS_INTEGRATION.md](./guides/X402_GASLESS_INTEGRATION.md) — gasless integration

## Reports (historical)

- [reports/COMPLETE_SYSTEM_TEST_REPORT.md](./reports/COMPLETE_SYSTEM_TEST_REPORT.md) — end-to-end platform test snapshot

## History

Weekly + monthly grant reports live in [`docs/history/`](./history/) — SUI Foundation deliverables kept for provenance. Read for period-scoped shipped work.

## Integrations

- [integrations/MOONLANDER_INTEGRATION.md](./integrations/MOONLANDER_INTEGRATION.md) — Moonlander perp routing
