# ZKward — Setup & Quick Start

This guide covers **local development** and the fastest way to interact with the live product.
For architecture + deep-dive docs, see `ARCHITECTURE.md`. For the demo flow, see `../demo/README.md`.

## Just want to try the product?

**No setup needed.** The whole platform is live:

- App: <https://www.zkward.com>

Sign in with email or Google — Privy auto-provisions a Hedera-testnet embedded wallet. Use the in-app Faucet button to mint 100 test USDC, then deposit.

---

## Local development

### Prerequisites

- **Node.js** ≥ 20 (Next 16 requirement)
- **bun** ≥ 1.1 — canonical package manager for this repo (`npm install --legacy-peer-deps` also works for Vercel install)
- **git**
- Optional: **Python 3.11** if you want to run the ZK-STARK prover locally (`zkp/`)

### 1. Clone + install

```bash
git clone https://github.com/ZkVanguard/zkward-ethglobal
cd zkward-ethglobal
bun install
```

### 2. Environment

Copy `.env.example` → `.env.local` and fill in the values you need. Minimum for local dev of the frontend:

```bash
# Read from any Hedera testnet RPC — no key needed
NEXT_PUBLIC_HEDERA_NETWORK=testnet

# Privy — sign up at https://dashboard.privy.io for a free App ID
NEXT_PUBLIC_PRIVY_APP_ID=<your-privy-app-id>

# Optional: pool DB (read-only surfaces work without it)
POSTGRES_URL=<your-aiven-or-neon-postgres-url>
```

For write flows (deposit, admin routes, HCS attestation) you'll also need:

```bash
HEDERA_OPERATOR_ID=0.0.xxxxxx
HEDERA_OPERATOR_KEY=<ECDSA-secp256k1-hex>
CRON_SECRET=<any-strong-secret>       # gates /api/admin/* + cron routes
```

Full canonical env list is in `.env.example`.

### 3. Run

```bash
bun run dev              # Next.js dev server on http://localhost:3000
bun run typecheck        # must pass before commit
bun run test             # jest full suite
bun jest test/integration/pool-drawdown-defense.test.ts    # MUST stay green
```

---

## Interacting with the live vault

### Faucet a test wallet

Any address can pull 100 test USDC + 1 HBAR from the built-in faucet:

```bash
curl -X POST https://www.zkward.com/api/hedera/faucet \
  -H 'content-type: application/json' \
  -d '{"address": "0xYOUR_HEDERA_EVM_ADDRESS"}'
```

### Run the real paid x402 call end-to-end

```bash
bun run scripts/demo-x402-permit.ts
```

Ephemeral wallet → faucet mint → EIP-2612 permit signature → 200 OK with `verification.mode: 'zkward-eip2612'` + HCS receipt.

### Hedera GraphQL adapter (open-source npm)

```bash
npm install @zkward/hedera-graphql-adapter
```

```typescript
import { createAdapter } from '@zkward/hedera-graphql-adapter';

const adapter = createAdapter({ network: 'testnet' });
const pools = await adapter.query('{ pools { id totalNav memberCount } }');
```

Serves the same schema on Hedera that Graph Studio serves on Sepolia — one query, two chains.

---

## Deployed contracts

| Chain | Purpose | Address |
|---|---|---|
| Hedera Testnet (296) | Primary vault — SimpleUsdcVaultV2 | `0x18a8d89E3674EBCeC678f97A8a8b1D144b330b88` |
| Hedera Testnet (296) | Test USDC (MockERC20Permit) | `0xe40AbC51A100Fa19B5CddEea637647008Eb0eA0b` |
| Sepolia (11155111) | SimpleUsdcVault (for Graph indexing demo) | `0x68eee8378935a90343347f5e4438eaad4b53111b` |
| SUI Mainnet | Community pool (v0.2.0) — package | `0x107292a69eea2f6eaf4a4e4727ee25d747b04c1985441b138933f0ef33f7b726` |

HCS audit topic (Hedera Testnet): `0.0.10393879` — [browse on HashScan](https://hashscan.io/testnet/topic/0.0.10393879).

---

## Troubleshooting

- **Vercel deploy fails on security scan** — the scan flags long minified lines; check `scripts/security-scan.cjs` output before deleting the offending file, most flags are safe to ignore for repo-internal builds.
- **`bun install` peer-dep warning** — expected; wagmi + viem versions are tuned for stability. Use `npm install --legacy-peer-deps` if bun's resolution rejects.
- **Hedera embedded wallet takes 2-5s** — normal on Google-first login. Dashboard shows "Creating your Hedera-testnet embedded wallet…" during the gap.
- **Chart shows flat `$1.0000` share price** — by design. The Hedera vault uses ERC-4626-lite math (no on-chain yield accrual). Look at `Total NAV history` and the projected metrics for movement.

---

## Related docs

- `ARCHITECTURE.md` — full system diagram
- `../demo/README.md` — 3-min demo cheat sheet
- `../CLAUDE.md` — repo guidance for Claude Code (personal, gitignored)
- `SLO_AND_RUNBOOKS.md` — production runbooks
