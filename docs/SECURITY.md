# Security policy

## Reporting a vulnerability

Do not open a public issue for an active vulnerability. Email
`ashishregmi2017@gmail.com` or use GitHub's private
[security advisory](https://github.com/ZkVanguard/ZkVanguard/security/advisories/new).
PGP available on request.

Include:

- Vulnerability class
- Affected paths + commit hash
- Reproduction steps
- Proof-of-concept if you have one
- Impact analysis

## Response

- Acknowledgment within 48 hours
- Initial assessment within 7 days
- Weekly updates until resolution
- Critical on-chain issues get an emergency deploy within 24 hours

## Supported versions

| Version | Status |
|---|---|
| v0.2.0 | Supported — current mainnet |
| v0.1.0 | Unsupported |

## Defense posture

TVL is contract-capped at $10K by `admin_set_tvl_cap` until the external
audit closes. Structural guards run always-on: strict NAV-oracle mode,
drawdown halt, circuit breaker, 3-way reconciliation, non-custodial
withdrawal math, geo-block, `close_hedge` funds-verify. Operational
internals are intentionally not enumerated here.

## Handling secrets

- `.env.local` is never committed
- Signing keys are server-only; every env read is `.trim()`'d for CRLF
- Private keys are not logged and not written to alert context

## Bug bounty

See [`BUG_BOUNTY.md`](./BUG_BOUNTY.md) for current status.

---
Last updated: 2026-09-25
