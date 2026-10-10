# Service Level Objectives + Top-7 Incident Runbooks

> Formal SLOs + step-by-step response for the highest-impact failure modes.
> Written for a solo operator today; scales to on-call rotation later.
> Extended 2026-07-15 with Runbooks 6-7 for the v0.3.0 defense system.

## Part 1 — Service Level Objectives

### Definitions

| Concept | Definition |
|---|---|
| **User** | Anyone with active shares in the SUI USDC pool + API consumers of `/api/platform/*`, `/api/portfolio/*` |
| **Available** | The primary user journey works: deposit works OR withdraw works OR read APIs respond within timeout |
| **Correct** | Prices are within 100 bps of the reference oracle AND share price computed from on-chain state matches what's returned via API within 50 bps |
| **Fresh** | NAV snapshot age < 45 min (1.5× cron cadence) |

### Targets

| SLI | Target | Error budget (30d) |
|---|---|---|
| API availability (95th %ile response < 2s) | 99.5% | 3.6 hours |
| NAV freshness | 99.0% | 7.2 hours of stale > 45min |
| Cron heartbeat (all 13 scheduled crons within 2× cadence) | 99.5% | 3.6 hours |
| Correct share price (deviation < 50 bps vs on-chain truth) | 99.9% | 43 minutes |
| Trade execution success (openHedge fills within 10s of orderHash) | 95% | 36 hours |
| Zero unauthorized state changes (admin actions signed by cap-holder only) | 100% | ZERO tolerance |

### Error budget policy

- **75% consumed** → post-mortem incident review + freeze feature deploys until burn rate falls below 1× budget/day
- **100% consumed** → mandatory 24h freeze; only reliability fixes ship
- **200% consumed** → escalate to external assistance (audit firm, on-call engineer)

## Part 2 — Top-7 Incident Runbooks

Each runbook has: **symptom** (what you'll see) → **diagnose** (what to check) → **mitigate** (immediate stop-bleed) → **fix** (root cause) → **verify**.

---

### Runbook 1 — Proof server down

**Symptom**
- `/api/zk-proof/health` reports `unhealthy` or `unavailable`
- `/api/zk-proof/generate` answers 503
- With `ZK_ATTEST_STRICT=1`, trades at or above `REPORTING_ZK_REQUIRED_USD` are refused, because the agent cycle produced no verified proof

**Diagnose**
```bash
# 1. Is the process answering?
curl -m 3 $ZK_API_URL/health

# 2. If unreachable:
ps aux | grep "zkp/api/server"       # linux
Get-Process python                    # windows
```

**Mitigate (< 5 min)**
- Unset `ZK_ATTEST_STRICT`: the proof gate is then off and trading does not
  depend on the prover. Nothing else depends on it.

**Fix**
- Restart the server: `python zkp/api/server.py`. It proves and verifies one
  statement at start and exits if that fails, so a listening port means a
  working prover. It needs a CPU only.

**Verify**
- `/health` returns `status: healthy`
- `python -m pytest zkp/tests/test_server.py`
- `ZK_API_URL=<address> bun jest test/integration/zk-hedge-policy.test.ts` passes in seconds, not milliseconds

---

### Runbook 2 — BlueFin returns garbage / matching engine unresponsive

**Symptom**
- Every openHedge returns success + orderHash but `getPositions()` never shows the fill
- `bluefin-health` cron logs 3-strike de-risk trigger (auto-closes all reduceOnly)
- Discord: `Auto-hedge PENDING: ... awaiting fill` for > 15 min
- Manual `/api/admin/bluefin-debug` returns stale positions

**Diagnose**
```bash
# 1. Is the BlueFin API up at all?
curl -m 5 https://api.sui-prod.bluefin.io/markets

# 2. Is it our credentials or theirs?
curl -sH "Authorization: Bearer $CRON_SECRET" \
  "https://www.zkward.com/api/admin/bluefin-preflight"

# 3. Test-order one signature:
curl -sH "Authorization: Bearer $CRON_SECRET" \
  -X POST "https://www.zkward.com/api/admin/bluefin-trace-order" \
  -d '{"symbol":"BTC-PERP","side":"LONG","size":0.001,"leverage":3}'
```

**Mitigate (< 10 min)**
- Set `SUI_AUTO_HEDGE_DISABLE=1` in Vercel env → cron stops opening new
  positions
- `POST /api/admin/close-bluefin-positions` (CRON_SECRET-gated) → flatten
  all existing positions to book PnL now instead of leaking on stale orders
- Notify LPs via Discord: pool paused pending venue investigation

**Fix**
- If BlueFin API is down: watch their status page, wait
- If our credentials expired: rotate `BLUEFIN_PRIVATE_KEY` via
  admin-preflight → new-key
- If specific market symbol is offline (e.g., SUI-PERP maintenance): set
  `HEDGE_SKIP_SUI=1` to route around

**Verify**
- Trace-order returns a fill (positions delta > 0)
- 3 consecutive `bluefin-health` ticks pass
- Revert `SUI_AUTO_HEDGE_DISABLE`

---

### Runbook 3 — Aiven Postgres region outage

**Symptom**
- Every DB-dependent call in `/api/*` returns 500 or hangs
- Cron routes log `ensureTable failed`, `Failed to get "..."`
- `analyze-pool-pnl.ts` fails at connection

**Diagnose**
```bash
# 1. Is Aiven up?
curl -m 5 https://api.aiven.io/v1/project/status

# 2. Are we hitting connection limits?
# Look at Aiven console → PostgreSQL → Metrics → active connections

# 3. Is DNS resolving?
nslookup pg-eb4412d-ashishregmi2017-fa7c.l.aivencloud.com
```

**Mitigate (< 30 min)**
- Set `DB_READ_ONLY_MODE=1` in Vercel env (implement if not present — 1
  hour eng) → API returns cached values from cron_state instead of live
  queries
- On-chain reads still work (pool state via Sui RPC is authoritative for
  NAV) — surface these on the dashboard with a "DB temporarily
  unavailable" banner

**Fix**
- Aiven multi-region failover (if Business tier is active): promote
  read replica
- Otherwise: wait, monitor, coordinate with Aiven support

**Verify**
- Cron heartbeats resume within 2 cycles
- `analyze-pool-pnl.ts` runs clean

---

### Runbook 4 — Admin key compromise (suspected or confirmed)

**Symptom**
- Unexpected `AdminEvent` on-chain
- Unusual fee withdrawals
- Strict NAV mode toggled without operator action
- Discord fires unfamiliar TVL cap change

**Diagnose**
```bash
# 1. Recent admin transactions via Sui RPC
sui client txs --address $SUI_ADMIN_ADDRESS --limit 20

# 2. Check any pending MSafe proposals — is someone probing?

# 3. Was the key exposed?
grep -r "SUI_POOL_ADMIN_KEY" ~ /tmp /var/log 2>/dev/null | head
```

**Mitigate (< 15 min) — HIGHEST PRIORITY**
- On the compromised host: `kill -9` every process using the key
- **DO NOT** delete the key file — forensic evidence
- Pause the pool via MSafe (if AdminCap already migrated per
  `docs/ADMINCAP_MSAFE_MIGRATION.md`) or via a fresh cap-holder invoking
  `admin_set_paused(true)`
- Set `SUI_AUTO_HEDGE_DISABLE=1` in Vercel
- Rotate all cron QStash tokens (attacker could forge cron calls)

**Fix**
- Generate new admin key via Sui CLI
- If AdminCap still on hot key: emergency-transfer to new address via the
  compromised key IF it's still under our control (may already be
  drained). Otherwise: build a governance escape hatch via MSafe.
- Deploy AdminCap migration to MSafe TODAY (was TA5 runbook prep)
- Force-close all BlueFin positions
- Rotate BLUEFIN_PRIVATE_KEY, DATABASE_URL, QSTASH_TOKEN, CRON_SECRET,
  DISCORD_WEBHOOK_URL

**Verify**
- 24h continuous monitoring for further anomalies
- External security review before resuming operations
- Post-mortem published to LPs

---

### Runbook 5 — Cron cascade failure (multiple crons stop firing)

**Symptom**
- `/api/health/production` reports 3+ crons > 30 min stale
- No `Auto-hedge OPENED` events for > 2 hours
- QStash dashboard shows scheduled crons but no invocations

**Diagnose**
```bash
# 1. Are QStash schedules present?
curl -sH "Authorization: Bearer $QSTASH_TOKEN" $QSTASH_URL/v2/schedules

# 2. Are cron routes throwing 5xx (blocking QStash from marking success)?
curl -sH "Authorization: Bearer $CRON_SECRET" \
  https://www.zkward.com/api/health/production | jq .components.cronJobs

# 3. Vercel deploy status
curl -sH "Authorization: Bearer $VERCEL_TOKEN" \
  "https://api.vercel.com/v6/deployments?projectId=$PROJECT_ID&limit=3"
```

**Mitigate (< 10 min)**
- Manually trigger the most critical cron (sui-community-pool) to force a NAV snapshot:
  ```bash
  curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
    https://www.zkward.com/api/cron/sui-community-pool
  ```
- If Vercel is down: no mitigation — sit tight, monitor Vercel status

**Fix**
- If the last deploy broke a shared module: `vercel rollback` to previous
- If QStash schedules were deleted (mis-click): recreate per
  `docs/AGENT_PIPELINE_ACTIVATION.md`
- If routes 5xx: fix root cause per stack trace

**Verify**
- All 13 crons show `cron:lastRun:*` within 2× cadence
- `/api/health/production` reports healthy

---

### Runbook 6 — Phantom hedge rate spike (v0.3.0)

**Symptom**
- Discord `KILL`: "phantom hedge rate X% > 1% threshold — exchange fills unreliable"
- `alert-response-loop` cron auto-halts `polymarket-edge-trader` and `sui-community-pool` autohedge (if `ALERT_RESPONSE_EXECUTE_HALT=1`)
- New `hedges` rows with `status='phantom'` appearing at accelerating rate

**Diagnose**
```bash
# 1. Confirm phantom count in last hour
psql -c "SELECT COUNT(*), status FROM hedges WHERE created_at > NOW() - INTERVAL '1 hour' GROUP BY status"

# 2. BlueFin ground-truth check
curl -s -H "Authorization: Bearer $CRON_SECRET" \
  https://www.zkward.com/api/admin/bluefin-debug | jq

# 3. Check for known root causes:
#    - Isolated-margin bug regression (BlueFin config change on their side)
#    - Step-size mismatch (new symbol added without pair spec)
#    - Free collateral < required for opens
```

**Mitigate**
- Autohedge already halted by `alert-response-loop`. If not, set `SUI_AUTO_HEDGE_DISABLE=1` and redeploy
- Set `PORTFOLIO_DRIVER_EXECUTE=` (empty) to prevent driver from opening more hedges

**Fix**
- Root cause almost always in `BluefinService.openHedge` invariant chain (see [`DEPLOY_RUNBOOK.md`](./DEPLOY_RUNBOOK.md) Appendix Y)
- If step size changed at venue: update `BLUEFIN_PAIRS` in `BluefinService.ts`
- If free collateral shortfall: increase `BLUEFIN_TARGET_MARGIN_USD` or top-up via `BLUEFIN_TOPUP_SWAP_FROM_SUI=1`

**Verify**
- Phantom count in last hour drops to 0
- Test-open a single hedge via `POST /api/admin/bluefin-trace-order` — must show fill in `getPositions()` within 5s
- Bulletproof test still green: `bun jest test/integration/pool-drawdown-defense.test.ts`

---

### Runbook 7 — Alert-response-loop misfires (v0.3.0)

**Symptom**
- Alert-response-loop takes actions that seem wrong: shrinks spot when NAV looks healthy, unwinds when no profit-lock, etc.
- Discord shows repeated `🤖 Auto-response:` messages

**Diagnose**
```bash
# 1. Inspect current alert log ring buffer
psql -c "SELECT value FROM cron_state WHERE key='alert-log:ring-buffer'" | jq '.'

# 2. Check profit-lock zero-since timestamp
psql -c "SELECT value FROM cron_state WHERE key='profit-lock:zero-since'"

# 3. Recent alert-response-loop runs
psql -c "SELECT * FROM cron_state WHERE key='cron:lastRun:alert-response-loop' ORDER BY updated_at DESC LIMIT 5"
```

**Mitigate**
- Set `ALERT_RESPONSE_EXECUTE=` (empty) — loop returns to log-only immediately
- If HALT_TRADER / HALT_AUTOHEDGE fired incorrectly, clear the halt state:
  ```sql
  DELETE FROM cron_state
   WHERE key IN (
    'polymarket-edge:halted-until',            -- HALT_TRADER destination
    'cron:haltUntil:sui-community-pool:autohedge',  -- HALT_AUTOHEDGE (via setCronHalt)
    'cron:haltReason:sui-community-pool:autohedge'
  );
  ```

**Fix**
- Review `lib/services/alerting/alert-response-loop.ts` rule thresholds
- Likely culprit: alert log accumulated stale entries (ring buffer > 200 old KILLs); clear via:
  ```sql
  UPDATE cron_state SET value='[]'::jsonb WHERE key='alert-log:ring-buffer';
  ```

**Verify**
- No auto-response messages for 30 minutes after clearing
- Re-flip `ALERT_RESPONSE_EXECUTE=1` only after root cause understood

---

## Part 3 — On-call artifacts

### Runbook access matrix

| Scenario | Who has authority | Escalation SLA |
|---|---|---|
| Runbooks 1, 2, 5 (technical) | Any engineer with prod access | 30 min ack |
| Runbook 3 (DB) | Same + Aiven admin | 15 min ack |
| Runbook 4 (key compromise) | Founder + external security firm | 15 min ack, active response within 1h |

### Communication template — post-incident

```
[POST-MORTEM] YYYY-MM-DD Incident: <short title>

## What happened
<one paragraph, plain english>

## User impact
- Duration: X min
- Users affected: <count>
- Funds at risk: $X (specify: at-risk, actually-lost, recovered)

## Timeline (UTC)
- HH:MM  Discord alert fires
- HH:MM  On-call ack
- HH:MM  Mitigation deployed
- HH:MM  Root cause identified
- HH:MM  Fix deployed
- HH:MM  Verified stable

## Root cause

## What went well

## What didn't

## Follow-ups (with owners + dates)
- [ ] ...
- [ ] ...
```

Published within 3 business days of every P0/P1 to LPs + on `/incidents` page.

## Part 4 — Chaos game-day schedule

Once per quarter, deliberately induce each Runbook scenario in a staging env:

- Q1 — Runbook 1 (kill Python prover)
- Q2 — Runbook 2 (mock BlueFin returning stale data)
- Q3 — Runbook 3 (revoke DB creds)
- Q4 — Runbook 5 (delete a QStash schedule)

Runbook 4 (key compromise) is drilled tabletop, never actually — the recovery path is destructive.

## Related

- `docs/AGENT_PIPELINE_ACTIVATION.md` — normal-operation flow
- `docs/ADMINCAP_MSAFE_MIGRATION.md` — hardens against Runbook 4
- `docs/HEDGE_PRIVACY_MAINNET_DEPLOY.md` — hardens against Runbook 4
- [SCALABILITY_ANALYSIS.md](./SCALABILITY_ANALYSIS.md) — scale-readiness walls for future work
