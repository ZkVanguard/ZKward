# Deploy & Secret-Rotation Runbook

> Post-incident production deploy for the SUI Mainnet Community Pool. This runbook
> exists because an obfuscated loader was found in `next.config.js`. It walks the
> operator from "clean repo, exposed secrets" to "verified-clean live deployment."
>
> **Verified ground truth at time of writing (2026-05-24):**
> - `origin/main` is **clean** — fix `01f962f8` and build guard `4846c665` are pushed; its `next.config.js` is 229 lines, longest line 146 chars, zero loader signatures.
> - Local `main` is **4 commits ahead** of origin (the Stage-3 refactors `55ddcf73 5e5906b1 1dc6b841 d6a78ed0`), not yet pushed.
> - `prebuild` runs `scripts/security-scan.cjs`, so an infected tree can no longer be built.
>
> So remote-malware eradication is **already done**. What is NOT done: the secret
> exposure that already happened, pushing the unpushed commits, and confirming the
> *live Vercel bundle* isn't a stale build from the infected window.

---

## 1. Threat model & exposure window

| Fact | Value |
|---|---|
| Payload first introduced | `9b6711ce` |
| Removed, then **re-added** by | `6ea125ea` — **2026-05-08** |
| Removed (current) | `01f962f8` — **2026-05-22 20:12 -0400** |
| Build guard added | `4846c665` — **2026-05-22 20:16 -0400** |
| Exposure window | **~14 days**, 19 commits (2026-05-08 → 2026-05-22) |
| Location | `next.config.js` — runs in the Node **build + server** process |

**Why this means rotate secrets:** `next.config.js` executes inside the Node process
that has full `process.env` access during `next build` and at server runtime. Any
secret present in the Vercel (or local build) environment during the exposure window
must be treated as **compromised**. We do not have proof of exfiltration, so this is
conservative-by-necessity — the correct posture for a confirmed malware incident.

**Why audit the dev machine (not just the repo):** the payload was removed once and
**came back** (`9b6711ce` → removed → re-added at `6ea125ea`). A repo that reinfects
points at a compromised author machine or an automated merge path, not a one-off
commit. Eradicating it from `origin` does not eradicate the source.

---

## 2. Pre-flight verification (read-only — safe to run anytime)

Run from the repo root. None of these change state.

```bash
# 2.1 — confirm the working tree and remote are clean of the loader
bun run security:scan                    # scans all tracked JS/TS; exits non-zero on any hit
git show origin/main:next.config.js | tail -3   # must end at: module.exports = withNextIntl(nextConfig);

# 2.2 — confirm exactly what is unpushed (expect only the 4 Stage-3 commits)
git log --oneline origin/main..main

# 2.3 — typecheck + build gate locally (prebuild guard runs automatically inside build)
bun run typecheck
bun run build                            # if this passes, the guard passed too
```

**Gate:** do not proceed past this section unless 2.1 prints `security scan clean`
and 2.3 builds green.

---

## 3. Push the clean local commits

The 4 unpushed commits are behavior-preserving refactors with 193 passing unit tests;
they do not touch `next.config.js`. Safe to push.

```bash
git push origin main
```

> Note: there are also two untracked files (`week-11-submission.md`,
> `week-18-22-submission.md`). They are docs, not code — commit or ignore per your
> preference; they have no bearing on the deploy.

---

## 4. Force a clean Vercel rebuild and verify the LIVE bundle

`origin` being clean does **not** guarantee the *currently-serving* deployment is
clean — it may still be the last build from the infected window, and Vercel can serve
a cached build.

1. **Trigger a fresh production build** from the clean `main` (push in §3 will do this,
   or "Redeploy" in the Vercel dashboard with **"Use existing build cache" UNCHECKED**).
2. **Confirm the build ran the guard:** in the Vercel build logs, look for
   `✓ security scan clean (<N> tracked source files)` emitted by `prebuild`. If the
   build succeeded, the guard passed (it `exit 1`s otherwise).
3. **Confirm the deployment commit** is at or after `01f962f8` (the removal). Reject any
   deployment whose source commit is in the `6ea125ea..01f962f8` range.
4. **Spot-check the served bundle** (optional but cheap): fetch the deployed site and
   grep the served JS for the signatures — there should be zero hits:
   ```bash
   # replace with the production URL
   curl -s https://<prod-host>/_next/static/ ... | grep -E "global\.i=|_\\\$_[0-9a-f]{4}|=lyR\("
   ```

---

## 5. Rotate secrets — the part that actually matters

Order matters: rotate **infra/API secrets first** (low risk, no fund movement), then
the **signing keys** (fund-moving, do during a maintenance window). Set the kill switch
before touching signer keys.

### 5a. Engage the kill switch first (maintenance window)

In Vercel env, set and redeploy (or hot-set if your infra allows):

```
SUI_AUTO_HEDGE_DISABLE=1     # fully disables auto-hedging
```

This stops the `sui-community-pool` cron from opening new hedges while keys are in flux.
Leave the autonomous trader (`polymarket-edge-trader`) off too if it shares the key —
easiest is to pause those QStash schedules in the QStash console for the window.

### 5b. Rotate infra / API secrets (no fund movement — do immediately)

For each, generate a new value at the provider, update it in Vercel env, redeploy:

| Secret | Provider action |
|---|---|
| `DB_V2_DATABASE_URL` (Neon) | Rotate the Neon role password / connection string |
| QStash signing keys + `CRON_SECRET` | Rotate in Upstash QStash console; update both current+next signing keys |
| Redis / Upstash token | Rotate in Upstash |
| `CRYPTOCOM_DEVELOPER_API_KEY` | Regenerate in Crypto.com developer console |
| `ASI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` | Regenerate at each provider (only the ones actually set) |
| `DISCORD_WEBHOOK_URL` | Delete + recreate the webhook in Discord channel settings |

### 5c. Rotate the SUI signing keys (FUND-MOVING — operator executes, confirm each step)

> **STOP.** These keys control real funds and on-chain authority. This is a coordinated
> migration, not a find-and-replace. Do it in the maintenance window with §5a engaged,
> and confirm each on-chain transfer before the next.

The exposed signers:
- `SUI_POOL_ADMIN_KEY` — operator key. Also the fallback is `BLUEFIN_PRIVATE_KEY`.
- `BLUEFIN_PRIVATE_KEY` — SUI keypair that authenticates the Bluefin perp account (its
  collateral lives in the Bluefin margin account keyed to this address).

These keys do **not** themselves hold the pool's authority — the on-chain **caps** do
(`SUI_ADMIN_CAP_ID`, `SUI_AGENT_CAP_ID`, `SUI_FEE_MANAGER_CAP_ID`, the last currently
held by the MSafe). Rotation = move the caps + gas + collateral to a new
address, then swap the env value.

Migration steps:
1. **Repatriate Bluefin collateral first.** Close/reduce-only any open perp positions and
   withdraw USDC collateral back to the operator wallet (so nothing is stranded under the
   old key's margin account). Verify on Bluefin that free + locked collateral is 0.
2. **Generate a new keypair** (offline / hardware-backed if possible). Record the new
   address. Never log or paste the private key into chat, CI, or a ticket.
3. **Transfer owned objects to the new address:** the `AdminCap` and `AgentCap` objects
   (the IDs in `SUI_ADMIN_CAP_ID` / `SUI_AGENT_CAP_ID`), plus enough SUI for gas. The
   `FeeManagerCap` is held by MSafe — coordinate that move through the MSafe multisig
   separately if its controlling signer was also exposed.
4. **Move residual assets** (idle USDC/SUI) from the old operator address to the new one.
5. **Update env:** set `SUI_POOL_ADMIN_KEY`, `BLUEFIN_PRIVATE_KEY` (and
   `SUI_ADMIN_ADDRESS` / `BLUEFIN_WALLET_ADDRESS` if the address changed) to the new key.
   The cap **ID** env vars stay the same — the objects moved, their IDs didn't.
6. **Redeploy** and verify §7 before re-enabling hedging.
7. **Abandon the old key.** Once verified, the old address should hold nothing of value.

> If a full signer migration can't be done immediately, the defensible interim is:
> rotate all of §5b now, keep §5a (kill switch) engaged, and schedule §5c for the
> next maintenance window — but treat the signer as compromised until then (no large
> idle balances under it).

---

## 6. Restore Neon compute

Neon was over monthly compute quota, which is why DB-dependent diagnostics report
INDETERMINATE rather than real numbers.

1. In the Neon console, raise the plan/quota or wait for the monthly reset; confirm the
   compute endpoint is active (not suspended).
2. Confirm the **rotated** `DB_V2_DATABASE_URL` (from §5b) is what's live in Vercel.
3. Smoke test connectivity (read-only):
   ```bash
   bun run scripts/analyze-pool-pnl.ts            # ~5s; full NAV/PnL picture
   bun run scripts/check-hedge-signal-alignment.ts # ~3s; hedges vs live Polymarket signal
   ```
   These now return real figures instead of INDETERMINATE once Neon is back.

---

## 7. Post-deploy verification

Run after §3–§6. Then re-enable hedging.

```bash
# on-chain + DB truth (read-only)
bun run scripts/analyze-pool-pnl.ts                 # NAV decomposition, share-price return, ATH
bun run scripts/check-hedge-signal-alignment.ts     # open hedges still match the signal?
```

Manual checks:
- **Crons firing:** QStash console shows `sui-community-pool`, `bluefin-health`,
  `polymarket-edge-trader`, fee-collect etc. succeeding (200s), not auth-failing on the
  rotated `CRON_SECRET` / QStash keys.
- **Discord:** a trade/rebalance/health event posts to the **new** webhook.
- **NAV sane:** `analyze-pool-pnl.ts` verdict line is profit/flat, not a garbage value
  (sanity ceiling `NAV_SAFETY_CEILING_USDC` not breached).
- **Re-enable hedging:** remove `SUI_AUTO_HEDGE_DISABLE`, un-pause QStash schedules,
  redeploy. Watch the first `sui-community-pool` and `polymarket-edge-trader` ticks.

> Do **not** trust `scripts/check-sui-mainnet-readiness.ts` as the gate —
> it checks legacy env names and doesn't load `.env.local`, so it reports false
> "blockers" for an already-deployed mainnet. Trust on-chain state + the two scripts above.

---

## 8. Rollback

- **Bad build:** in Vercel, promote the last known-good deployment (must be a commit
  `>= 01f962f8` AND `< any` infected commit — i.e. on clean `main`). Never roll back into
  the `6ea125ea..01f962f8` window.
- **Bad key migration:** if a cap/asset transfer half-completed, do **not** redeploy with
  mismatched env. Re-engage `SUI_AUTO_HEDGE_DISABLE=1`, reconcile object ownership
  on-chain (`sui client objects <address>`), then retry §5c from the failed step.
- **DB issues:** point `DB_V2_DATABASE_URL` back at a healthy endpoint; diagnostics
  degrade gracefully to INDETERMINATE rather than reporting false losses.

---

## Appendix Z — profit-tuning config (Sharpe-oriented preset)

Pool target: **stability + Sharpe**, not absolute return. Depositor trust is the moat.
Set these in Vercel production env. None are secrets — safe to commit a snapshot to
this runbook. Trader code reads them on every cron tick, no redeploy needed for env
changes (Vercel injects fresh env per invocation).

### Trader (`polymarket-edge-trader`)

```
POLYMARKET_EDGE_MIN_CONFIDENCE         = 70      # was 60 — only high-conviction
POLYMARKET_EDGE_MIN_CONSENSUS          = 70      # was 60 — require alignment
POLYMARKET_EDGE_LEVERAGE               = 2       # was 3  — smaller PnL swings
POLYMARKET_EDGE_STAKE_PCT              = 0.05    # was 0.10 — Kelly half
POLYMARKET_EDGE_MAX_STAKE_USD          = 100     # was 500 — bound single-trade loss
POLYMARKET_EDGE_MAX_CONSECUTIVE_LOSSES = 3       # was 5  — earlier kill
POLYMARKET_EDGE_MAX_DRAWDOWN_PCT       = 0.20    # was 0.30 — earlier kill
```

Raise `MAX_STAKE_USD` to 500 once pool NAV > $5k (Kelly stops binding the cap).

### Auto-hedge (`sui-community-pool` cron)

```
HEDGE_MIN_NAV_USD             = 100   # was 20  — don't hedge dust
HEDGE_RISK_THRESHOLD_DEFAULT  = 5     # was 0   — only hedge when risk elevated
HEDGE_DAILY_MAX_RESETS        = 2     # was 4   — preserve daily-cap teeth
HEDGE_RESET_MIN_CONFIDENCE    = 85    # was 75  — higher bar to override the cap
```

**`HEDGE_MIN_NAV_USD` must track current NAV.** Setting the floor above the
current pool NAV freezes the auto-hedge step entirely — every tick logs
"skipping Step 8". A target of roughly **60% of current NAV** keeps the pool
active while protecting against hedging dust:

| Pool NAV | `HEDGE_MIN_NAV_USD` |
|---|---|
| $0 - $50    | `30`  |
| $50 - $200  | `100` (recommended preset) |
| $200 - $500 | `150` |
| > $500      | `300` |

Why `30` is still safe at sub-$50 NAV: the `tiny` leverage tier (5x) and
100% hedge ratio combined with `HEDGE_RISK_THRESHOLD_DEFAULT=5` mean
auto-hedge only fires when risk is genuinely elevated, and at sub-$50
notional only SUI-PERP can clear BlueFin's minQty — BTC and ETH minQty
floors block accidental dust trades on those venues automatically.

### `SafeExecutionGuard` defaults (read at boot, hardcoded in
`agents/core/SafeExecutionGuard.ts`)

Bring slippage and leverage caps in line with the trader's tighter knobs:

```ts
maxSlippageBps: 30,     // was 50 — match POLYMARKET_EDGE_MAX_SLIPPAGE_BPS
maxLeverage:     4,     // was  5 — defense in depth above per-route LEVERAGE
```

(These two require a small code change; the other four `SafeExecutionGuard` caps —
`maxPositionUsd $10M`, `maxDailyVolumeUSD $100M`, `cooldownMs 5s`,
`consensusThreshold 0.67` — stay as is until pool NAV approaches them.)

### NAV-tiered leverage (`lib/services/sui/cron/hedge-sizing.ts`)

```ts
case 'tiny':   return 5;   // was 10 — still clears BlueFin minQty in most cases
case 'small':  return 3;   // was  5
```

(`medium=3`, `large=2` unchanged.)

### What this preset is NOT

- It is **not max EV.** It biases toward Sharpe and depositor-trust signals
  (low drawdown, fewer kill events) over absolute daily PnL.
- It is **not blind.** Each knob's tradeoff is documented inline above.
- It is **not permanent.** After the pool has logged ~50 real trades in Aiven,
  re-tune from the actual PnL distribution and win-rate-by-confidence histogram.

### Roll-out order

1. Land the env-var refactor commit (makes `MAX_CONSECUTIVE_LOSSES` and
   `MAX_DRAWDOWN_PCT` overrideable).
2. Set the trader + auto-hedge env vars in Vercel production. No redeploy needed.
3. Land the `SafeExecutionGuard` + `hedge-sizing` code changes in a follow-up
   PR. These DO require redeploy.
4. Watch one week of trader output via Discord `TRADE` and `KILL` alerts. If
   trade frequency drops below 1/day, lower `MIN_CONFIDENCE` to 65 and reassess.

### Scale-tier config (added 2026-05-31)

These env vars (all read on every cron tick — no redeploy needed) let
you scale the system as deposits grow without code releases. Set in
Vercel production. Defaults are tuned for sub-$10k AUM; raise per the
tier as deposits land.

**SafeExecutionGuard caps (`agents/core/SafeExecutionGuard.ts`):**

```
SAFE_GUARD_MAX_POSITION_USD       default 10_000_000   raise at $100k+ AUM
SAFE_GUARD_MAX_DAILY_VOLUME_USD   default 100_000_000  raise proportionally
SAFE_GUARD_MAX_SLIPPAGE_BPS       default 30           raise if spreads widen
SAFE_GUARD_MAX_LEVERAGE           default 4            keep low until $10M+
SAFE_GUARD_COOLDOWN_MS            default 5000         raise if rate-limited
```

**NAV ceiling pre-warning (`sui-community-pool/route.ts`):**

```
NAV_SAFETY_CEILING_USDC  default 10_000_000_000  hard halt — scale-readiness gate
                                                 (above: multi-venue router / OTC / u128 Move redeploy required)
NAV_SAFETY_WARN_PCT      default 80              % of ceiling at which to alert
                                                 (re-alerts every 6h while above)
```

**Aiven Postgres pool sizing (`lib/db/postgres.ts`):**

```
AIVEN_POOL_MAX  default 2   per-Vercel-instance connection limit
DB_POOL_MAX     fallback    generic catch-all if AIVEN_POOL_MAX not set
```

At default Aiven tier (`connection_limit=20` plan-wide) keep max=2 to
allow ~8 concurrent Vercel instances + scripts. Upgrade Aiven business
tier first, THEN raise.

**Position aging (`bluefin-db-reconcile` cron, T1-C):**

```
HEDGE_MAX_HOLD_HOURS  default 24    force-close positions older than this
                                    (0 disables — not recommended)
```

**BlueFin open-interest guard (`BluefinService.openHedge`, T3-B):**

```
BLUEFIN_OI_GUARD          default 'true'   set 'false' to disable entirely
BLUEFIN_MAX_OI_PCT        default 5        max % of venue OI per hedge
                                           (floor 0.5)
```

**DEX split-execution (`BluefinAggregatorService.executeSplitSwap`, T3-C):**

```
MAX_SWAP_PRICE_IMPACT_BPS  default 50      0.5% per-chunk price-impact ceiling
MIN_SWAP_CHUNK_USD         default 25      refuse to split smaller chunks
MAX_SWAP_CHUNK_COUNT       default 16      hard cap on iterations
SWAP_CHUNK_INTERVAL_MS     default 1500    inter-chunk settle delay
```

**Drawdown auto-halt (`sui-community-pool/route.ts` auto-hedge step):**

```
HEDGE_DRAWDOWN_HALT_PCT  default 10   % from peak NAV that triggers halt
                                      until UTC midnight
```

**Collateral floor (`/api/health/production` bluefin check):**

```
BLUEFIN_COLLATERAL_FLOOR_USD  default 5   when positions open + free below
                                          this, bluefin component goes WARN
```

## Appendix Y — BlueFin order invariants (silent-reject prevention)

BlueFin's Trade API returns an `orderHash` for any well-formed signed
request, even when the matching engine later silently drops the order.
We learned this the hard way on 2026-05-31. Every new code path that
opens or closes BlueFin orders MUST observe these invariants, or
positions get reserved on collateral without ever filling.

**1. Quantity must snap to per-symbol step size.**
The `BLUEFIN_PAIRS` map (`lib/services/sui/BluefinService.ts:76`) is
authoritative:
```
BTC-PERP  stepSize 0.001   minQty 0.001
ETH-PERP  stepSize 0.01    minQty 0.01
SUI-PERP  stepSize 1       minQty 1     ← whole SUI only
SOL-PERP  stepSize 0.1     minQty 0.1
```
Use `snapToStepSize(rawSize, pair.stepSize)` BEFORE signing. A
fractional SUI quantity returns an orderHash but is silently dropped.

**2. Leverage on a close must match the position's leverage.**
The pre-trade risk check sees the opposite-side close as opening a
new position and requires `notional / leverage` as free margin. At
hardcoded 1x leverage, closing a 3x position needs the full notional
free — usually impossible. Use `position.leverage`.

**3. Never pass `reduceOnly: true`.**
The BlueFin v2 SDK (`bluefinClient.js` line 464-466) explicitly warns
that reduceOnly is deprecated and the API rejects flagged orders.
Use a plain opposite-side MARKET order with `reduceOnly: false` and
let BlueFin's account-level netting do the work.

**4. Verify the fill — orderHash alone is not proof.**
Both `openHedge` and `closeHedge` snapshot the pre-trade position
size, submit, then poll `getPositions()` for up to 5s checking for
size change. Success requires ONE of:
- `filledQty >= 99%` of requested size in the response, OR
- non-empty non-zero `realizedPnl`, OR
- position visibly grew (open) or shrunk (close) during polling
Otherwise return `success: false` with `rawResponse` surfaced for
diagnosis. Don't ever return `success: true` based only on orderHash.

**5. If you must debug a silent reject**, hit
`GET /api/admin/bluefin-debug` (CRON_SECRET-gated). Returns
ground-truth `positions + openOrders + freeCollateral`.

## Appendix W — reconciliation topology

Three independent reconcile paths cover the three drift surfaces:

| Cron | Cadence | Compares | Repair |
|---|---|---|---|
| `sui-hedge-reconcile`     | 1h    | on-chain Move ↔ BlueFin | `admin_reset_hedge_state` |
| `bluefin-db-reconcile`    | 15min | BlueFin ↔ DB hedges      | close phantom DB rows; alert on orphan positions |
| `SuiHedgeReconciler.reconcileSuiHedges()` (service, on-demand) | — | on-chain Move ↔ DB hedges | INSERT missing; UPDATE closed |

Adding a new reconcile path: write the comparison + repair in a new
cron route under `app/api/cron/`, write a heartbeat via
`setCronState('cron:lastRun:<route>', Date.now())` at the top, fire a
`notifyDiscord` on detected drift, and schedule it on QStash via the
v2 API (see [[qstash-schedules]] memo). Add the freshness check to
`/api/health/production` so the operator sees it without polling logs.

## Appendix V — admin endpoints (operator escape hatches)

All CRON_SECRET-gated via `verifyCronRequest`. Not browser-callable.
Run from terminal during incident response.

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/admin/bluefin-debug`          | GET  | Ground-truth positions + openOrders + freeCollateral |
| `/api/admin/close-bluefin-positions`| GET  | Dry-run: list positions only |
| `/api/admin/close-bluefin-positions`| POST | Close every open BlueFin position (uses fixed closeHedge) |
| `/api/admin/reconcile-sui-hedges`   | POST | On-demand on-chain Move ↔ DB sync |

Example flatten-everything sequence:
```bash
SECRET="$(grep ^CRON_SECRET= .env.local | cut -d= -f2 | tr -d '\"')"
URL=https://www.zkward.com
curl -s -X GET  -H "Authorization: Bearer $SECRET" $URL/api/admin/bluefin-debug | jq
curl -s -X GET  -H "Authorization: Bearer $SECRET" $URL/api/admin/close-bluefin-positions | jq  # dry run
curl -s -X POST -H "Authorization: Bearer $SECRET" $URL/api/admin/close-bluefin-positions | jq  # commit
curl -s -X GET  -H "Authorization: Bearer $SECRET" $URL/api/admin/bluefin-debug | jq            # verify
```

## Appendix A — secret inventory (what lives where)

Fund-moving / highest priority: `SUI_POOL_ADMIN_KEY`, `BLUEFIN_PRIVATE_KEY`.
Infra/API: `DB_V2_DATABASE_URL`, QStash keys, `CRON_SECRET`, Upstash/Redis token,
`CRYPTOCOM_DEVELOPER_API_KEY`, `ASI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`DISCORD_WEBHOOK_URL`.
Not secret (on-chain object IDs — authority, not credentials; migrate objects, keep IDs):
`SUI_ADMIN_CAP_ID`, `SUI_AGENT_CAP_ID`, `SUI_FEE_MANAGER_CAP_ID`, the
`NEXT_PUBLIC_SUI_MAINNET_*` package/state IDs.

Reminder: every SUI env read must `.trim()` — Vercel values carry trailing
`\r\n`. Never log or hardcode a private key.

## Appendix B — audit the dev machine (because it reinfected once)

The payload was removed and **came back**, so the source is upstream of the repo.

```bash
# who/what authored the (re-)introduction
git show --stat 6ea125ea
git log --format='%an <%ae>  %ci' -1 6ea125ea
git show 9b6711ce --stat        # the first introduction

# did it arrive via the fork remote?
git remote -v                   # note the 'fork' remote (kyu36003-source/ZKward)
```

Checklist:
- Identify the machine that authored `6ea125ea` / `9b6711ce`; scan it for malware and a
  compromised git hook / editor extension / `postinstall` script that rewrites
  `next.config.js`.
- Audit `package.json` lifecycle scripts and any local git hooks for re-injection.
- Confirm the build guard (`prebuild` → `scripts/security-scan.cjs`) is present on every
  branch that can deploy, not just `main`.
- Rotate any developer credentials (GitHub tokens, SSH keys) on the affected machine.

---

## Appendix X — v0.3.0 autonomy defense env gates (shipped 2026-07-15)

The 8-gate autonomy defense system ships with every destructive action behind an env flag (default OFF) so operators can log-observe before flipping to live execution. Flip one at a time in Vercel env; watch Discord for 24h per gate before enabling the next.

| Env var | Prod state | Effect when `=1` | Owning module |
|---|---|---|---|
| `PORTFOLIO_DRIVER_EXECUTE` | **ON** (as of 2026-07-23) | PortfolioDriver actually executes SELL/BUY/OPEN/CLOSE | `lib/services/sui/PortfolioDriver.ts` |
| `STALE_HEDGE_AUTO_CLOSE` | **ON** (as of 2026-07-23) | `sui-hedge-reconcile` force-closes stale hedges (age > 7d + ≥ 2 flips + contradicted side) | `lib/services/sui/StaleHedgeDetector.ts` |
| `ALERT_RESPONSE_EXECUTE` | **ON** (as of 2026-07-23) | Alert-response-loop cron acts on rules (3 KILL/hr, 24h profit-lock, phantom > 1%) | `lib/services/alerting/alert-response-loop.ts` |
| `ALERT_RESPONSE_EXECUTE_HALT` | OFF | Additionally allows HALT_TRADER and HALT_AUTOHEDGE responses | (same as above) |
| `REGRET_TRACKER_DISABLE` | OFF (i.e. tracker is **ON** by default) | Disables the regret multiplier in `polymarket-edge-trader` stake calc | `lib/services/ai/regret-tracker.ts` |
| `STALE_HEDGE_AGE_DAYS` | `7` | Age threshold (days) above which a hedge is candidate for stale-close | `lib/services/sui/StaleHedgeDetector.ts` |
| `STALE_HEDGE_MIN_FLIPS` | `2` | Signal-flip count required in addition to age | (same) |
| `PROFIT_LOCK_DRAWDOWN_START` | `5` | Drawdown-% at which profit-lock begins clamping | `lib/services/sui/cron/profit-lock-guard.ts` |
| `PROFIT_LOCK_ZERO_RISK_AT` | `20` | Drawdown-% at which risk cap → 0 (100% USDC) | (same) |
| `PROFIT_LOCK_DISABLE` | OFF | Emergency bypass — turns off profit-lock entirely | (same) |

**Recommended rollout order (steps 1–5 done as of 2026-07-23):**

1. ✅ **Deploy v0.3.0 to Vercel** — all gates default OFF; watch Discord for 24h to confirm log-only messages appear at expected trigger points
2. ✅ Add QStash schedule for `/api/cron/alert-response-loop` (`scd_7Z4yqbBAJgT5Vuof5Ce9uJKNBy8Y`, every 15 min)
3. ✅ Flip **`PORTFOLIO_DRIVER_EXECUTE=1`** — the big one; unwinds existing spot when profit-lock fires
4. ✅ Flip **`STALE_HEDGE_AUTO_CLOSE=1`** — kills lingering positions that survive drift-close
5. ✅ Flip **`ALERT_RESPONSE_EXECUTE=1`** — closed-loop remediation active
6. 🔨 Flip **`ALERT_RESPONSE_EXECUTE_HALT=1`** — allows the auto-halt responses (the most destructive)

**Verify current gate state before flipping the last one:**
```bash
curl -sS https://www.zkward.com/api/health/production | jq .gates
```

### New QStash schedule required

The `alert-response-loop` route exists in code but has no schedule — Upstash-managed, not in `vercel.json`. Add via v2 API:

> **Known-stale heartbeat as of 2026-07-15 audit:** `cron:lastRun:health-monitor` is 13+ days stale in `cron_state`. The route code is fine (heartbeat write on line 56 fires before auth) — the QStash schedule itself is missing or disabled. **Re-add** with the snippet below (substitute `health-monitor` for `alert-response-loop`, cron `*/10 * * * *`). Both crons need scheduling.


```bash
curl -X POST -H "Authorization: Bearer $QSTASH_TOKEN" \
  -H "Upstash-Cron: */15 * * * *" -H "Upstash-Method: POST" \
  -H "Upstash-Forward-Authorization: Bearer $CRON_SECRET_FALLBACK" \
  -H "Upstash-Retries: 2" -d '{}' \
  "$QSTASH_URL/v2/schedules/https://www.zkward.com/api/cron/alert-response-loop"
```

### Verify from console

```bash
# Bulletproof drawdown-defense test — should stay 10/10 green after any change
bun jest test/integration/pool-drawdown-defense.test.ts

# Live smoke test — reads mainnet state, runs modules, prints what they'd do
# (no writes — safe on real mainnet)
bun run scripts/analyze-pool-pnl.ts

# Signal-alignment check — flags any active hedge contradicted by current signal
bun run scripts/check-hedge-signal-alignment.ts
```

### Emergency disable

If a gate misbehaves in production, set its env flag to empty (not `0` — the check is `=== '1'`) and redeploy. Log-only mode kicks in immediately — no destructive actions until re-flipped.
