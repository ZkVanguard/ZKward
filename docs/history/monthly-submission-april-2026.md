# Sui Monthly Submission — April 2026

## 1. Primary GitHub Repository

**https://github.com/ZkVanguard/ZkVanguard**

(Mirror: https://github.com/ZkVanguard/ai-agents)

## 2. GitHub Username (Author)

**`Mrare Jimmy`** (`mrarejimmy@icloud.com`)

All commits below are authored by this account.

## 3. Execution Path

- ☑ **Move smart contracts** — `contracts/sui/sources/community_pool_usdc.move` (`open_hedge` / `close_hedge` / `record_pnl`, on-chain `max_hedge_ratio_bps`, daily hedge cap)
- ☑ **Application / backend integration (SDK / RPC / Indexer)** — `@mysten/sui` SDK, Sui RPC, Bluefin Pro perp DEX, 7k aggregator
- ☑ **Integration with Sui ecosystem infrastructure** — Bluefin Pro (perp DEX on Sui), 7k Aggregator (DEX aggregator on Sui)

## 4. Work Completed This Month

1. **Bullet-proof three-layer hedge sync** (DB ↔ Sui on-chain pool ↔ Bluefin Pro perps).
   Added atomic helpers (`getHedgeByOnchainId`, `closeHedgeByOnchainId`, `recordSuiOnchainHedge`, `tryAcquireHedgeDecisionLock`), distributed Postgres-backed decision lock to prevent duplicate cron-tick hedges, and a reconciler that adopts orphan Bluefin perp positions into the DB. End-to-end verifier (`scripts/verify-bluefin-hedges.mjs`, `scripts/test-hedge-sync-e2e.mjs`, `scripts/verify-qstash-sync.mjs`) confirms all three layers in sync on mainnet.

2. **Bluefin Pro mainnet integration fixes**.
   Corrected the `BluefinService` parser to handle Bluefin Pro's E9 number format (`avgEntryPriceE9`, `markPriceE9`, `leverageE9`, `unrealizedPnlE9`, `marginAvailableE9` divided by `1e9`); derived position size from `initialMargin × leverage / entry` (Bluefin omits `quantity`); added preflight + auto-top-up of margin from spot wallet; restored visibility of a live SUI-PERP SHORT (3.81 SUI @ $0.953, +$0.178 unrealized PnL) that had previously been invisible to the cron.

3. **Move-contract correctness + capital-efficiency fixes for the SUI Community Pool cron** (`app/api/cron/sui-community-pool/route.ts`).
   Replaced the hardcoded 50% hedge-ratio with the on-chain `max_hedge_ratio_bps` value (was causing `E_MAX_HEDGE_EXCEEDED` aborts on every run); respected the contract's daily-hedge cap and 20%-reserve in `open_hedge` transfer sizing; lowered the auto-hedge NAV floor from `$1000` to `$30` (env-driven), lowered default risk-trigger from 8 to 5, added profit-protection on stale-perp force-close, raised the orphan-USDC dust gate from `$1` to `$5`, and made the cost-benefit gate scale with NAV. Eliminates the 8 wasteful 0-PnL cycles/day observed in production.

## 5. Sui Stack Components Used

- **Sui Move smart contracts** (custom `community_pool_usdc` module on Sui mainnet)
- **Sui SDK / RPC** (`@mysten/sui` Transaction builder, sponsored-tx flow, event indexing)
- **Bluefin Pro** (Sui-native perpetual DEX, used for protective SHORT hedges)
- **7k Aggregator** (Sui DEX aggregator, used for pool rebalancing swaps)
- **zkLogin / Slush wallet** (universal-link onboarding for mobile users)

## 6. Integration Description

The `community_pool_usdc` Move contract on Sui mainnet manages a multi-asset community pool. A Vercel/QStash-driven cron job (every 30 min) reads NAV + drift on-chain, runs an AI risk-scoring layer, then:

1. Transfers USDC from pool → admin via `open_hedge` (constrained by on-chain `max_hedge_ratio_bps` + daily cap), uses the proceeds to open SHORT perps on **Bluefin Pro**, and on the next cycle closes the perp and returns USDC to the pool via `close_hedge` (with realized PnL recorded on-chain through `record_pnl`).
2. Rebalances the pool's spot allocation through the **7k Aggregator** when drift × confidence exceeds a NAV-scaled cost threshold.
3. Reconciles three sources of truth — Postgres `hedges` table, on-chain pool state, and the live Bluefin perp account — every cron tick, with a Postgres-backed distributed lock preventing duplicate hedge decisions across overlapping cron invocations.

## 7. Verifiable Technical Evidence

### Move-contract / on-chain hedge logic
- `fdd78abb` — fix(sui-cron): use on-chain `max_hedge_ratio_bps` (was hardcoded 50% causing `E_MAX_HEDGE_EXCEEDED` aborts) — https://github.com/ZkVanguard/ZkVanguard/commit/fdd78abb
- `a3625b8a` — fix: respect daily hedge cap (15% NAV) in `open_hedge` transfer — https://github.com/ZkVanguard/ZkVanguard/commit/a3625b8a
- `85957e5b` — fix: cap `open_hedge` transfer at contract limits (50% hedge ratio + 20% reserve) — https://github.com/ZkVanguard/ZkVanguard/commit/85957e5b
- `60eb9930` — feat: add admin `reset_hedge_state` endpoint + Move contract function — https://github.com/ZkVanguard/ZkVanguard/commit/60eb9930

### Three-layer hedge sync (DB ↔ Sui on-chain ↔ Bluefin)
- `eb1ba5e0` — fix(sui-cron): bullet-proof three-layer hedge sync (DB ↔ on-chain ↔ Bluefin) — https://github.com/ZkVanguard/ZkVanguard/commit/eb1ba5e0
- `2271027b` — test(sui-cron): three-layer hedge sync E2E (decision lock, drift analysis) — https://github.com/ZkVanguard/ZkVanguard/commit/2271027b
- `277bce0f` — test(sui-cron): QStash schedule + DB sync verifier — https://github.com/ZkVanguard/ZkVanguard/commit/277bce0f
- `87e62f43` — fix(bluefin): correct E9 field parsing + reconcile orphan perps — https://github.com/ZkVanguard/ZkVanguard/commit/87e62f43

### Capital efficiency / hedge gating
- `05639231` — feat(cron): unlock auto-hedge for small pools, protect profitable stale perps — https://github.com/ZkVanguard/ZkVanguard/commit/05639231
- `7b7902ad` — fix(hedge): refuse dust `open_hedge` calls + honest win-rate stats — https://github.com/ZkVanguard/ZkVanguard/commit/7b7902ad
- `0d71e30f` — feat(hedging): calibration + risk math + cron hardening — https://github.com/ZkVanguard/ZkVanguard/commit/0d71e30f
- `5d82e779` — feat(sui): Bluefin V2 treasury auto-top-up + admin preflight/reconciler — https://github.com/ZkVanguard/ZkVanguard/commit/5d82e779

### Sui SDK / sponsored-tx + UX
- `a5e74740` — fix: 2-step sponsored tx — wallet builds, admin co-signs same bytes — https://github.com/ZkVanguard/ZkVanguard/commit/a5e74740
- `fe898062` — fix: reconstruct `Transaction` object from server JSON before wallet signing — https://github.com/ZkVanguard/ZkVanguard/commit/fe898062
- `f6f35fcf` — fix: Slush mobile deep link — universal link via `my.slush.app/browse/` — https://github.com/ZkVanguard/ZkVanguard/commit/f6f35fcf

### Security
- `6700b492` — security(critical): require auth on `/api/community-pool/auto-hedge` POST + clamp config + harden deposit input validation — https://github.com/ZkVanguard/ZkVanguard/commit/6700b492
- `b26abd64` — security: remove hardcoded SUI admin private key from refund scripts — https://github.com/ZkVanguard/ZkVanguard/commit/b26abd64

## 8. Deployment / Integration Proof (mainnet)

- **Sui Move package**: `0x9ccbabbdca72c5c0b5d6e01765b578ae37dc33946dd80d6c9b984cd83e598c88`
  https://suiscan.xyz/mainnet/object/0x9ccbabbdca72c5c0b5d6e01765b578ae37dc33946dd80d6c9b984cd83e598c88
- **Pool state object**: `0xe814e0948e29d9c10b73a0e6fb23c9997ccc373bed223657ab65ff544742fb3a`
  https://suiscan.xyz/mainnet/object/0xe814e0948e29d9c10b73a0e6fb23c9997ccc373bed223657ab65ff544742fb3a
- **USDC type**: `0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC`
- **Bluefin Pro operator wallet** (live SUI-PERP SHORT, +$0.178 unrealized PnL at submission):
  `0x99a3a0fd45bb6b467547430b8efab77eb64218ab098428297a7a3be77329ac93`
- **Live application**: https://www.zkward.xyz
- **Cron endpoint** (QStash schedule `scd_74megHcwNQpFTScvqsMgGTQzZnCc`, every 30 min):
  `https://www.zkward.xyz/api/cron/sui-community-pool`

### Verifier output (re-run today)

```
[A] Bluefin auth + account ........ OK (canTrade=true, freeCollateral=0.354893)
[B] getPositions ................. 1 (SUI-PERP SHORT 3.81 @ 0.9529, mark 0.9083, +0.1784 PnL)
[C] DB ↔ Bluefin perp positions .. in sync
[D] Live perp orders being placed . YES (last live open 2026-05-01T05:30:16Z)
=== Result: PASS ===
```
