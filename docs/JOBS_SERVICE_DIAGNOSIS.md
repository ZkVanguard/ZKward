# jobs.zkward.com — mass-halt diagnosis playbook

**When to open this doc.** Every scheduled cron stopped at roughly the same wall-clock second. Bakchodi query:

```sql
SELECT REPLACE(key,'cron:lastRun:','') AS cron,
       ROUND(EXTRACT(EPOCH FROM (NOW() - to_timestamp(value::text::bigint / 1000))) / 60, 1) AS mins_ago
FROM cron_state WHERE key LIKE 'cron:lastRun:%'
ORDER BY mins_ago;
```

If ≥ 8 crons all show `mins_ago` within the same 1-minute band, that's a **dispatcher-side outage**, not a route-side bug. Follow this playbook.

Known incident: **2026-09-19 20:11:04 UTC-4** — 11 crons stopped simultaneously. Undetected for ~24 hours until manual query surfaced it. This doc + `scripts/ping-crons.ts` + `.github/workflows/heartbeat-cron.yml` + `/api/cron/heartbeat-monitor` shipped together as the response so a repeat can't hide.

---

## Step 1 — Is the Vercel app itself up?

```
curl -sS -o /dev/null -w 'HTTP %{http_code}  %{time_total}s\n' \
  https://www.zkward.com/api/health/production
```

- **200** → app is fine. Skip to Step 2 (dispatcher-side).
- **500 / 502 / 503** → deploy is broken. Skip to Step 4 (deploy-side).
- **timeout / connection refused** → Vercel is down or DNS issue. Check Vercel dashboard.

## Step 2 — Is jobs.zkward.com dispatching?

**2a. Health check on the dispatcher itself:**
```
curl -sS -o /dev/null -w 'HTTP %{http_code}\n' https://jobs.zkward.com/health
```

**2b. List active schedules:**
```
curl -sS -H "Authorization: Bearer $JOBS_PUBLISH_TOKEN" \
  https://jobs.zkward.com/v1/schedules | jq '.[].cron'
```

Expected: at minimum `agent-signal-tick`, `polymarket-edge-trader`, `bluefin-health`, `liquidation-guard`, `pool-nav-monitor`, `bluefin-db-reconcile`, `alert-response-loop`, `sui-community-pool`, `sui-hedge-reconcile`, `sui-collect-fees`, `heartbeat-monitor`.

- **Dispatcher 200 + schedules present** → dispatcher is up but not firing. Check its internal cron loop / process logs. Likely a stuck worker or a scheduler-thread crash. Restart the service.
- **Dispatcher 200 + empty schedules** → schedules got wiped. Re-add them (see Step 5).
- **Dispatcher 500 / down** → SSH to the host, `systemctl status jobs.zkward.com` (or whatever service manager) + inspect logs. Restart the process. If it crashloops, roll back to the last known-good release.

## Step 3 — Manual heartbeat kick (buys time while diagnosing)

Directly ping each cron route with `CRON_SECRET`. Bypasses the dispatcher entirely — the routes still run, still heartbeat, still keep the trading + reconciliation flow alive.

```
BASE_URL=https://www.zkward.com CRON_SECRET=<value> \
  bun run scripts/ping-crons.ts
```

Reports each route's `HTTP status + latency + body preview`. Any non-200 is a route-side bug (contrast with the mass-halt above which was dispatcher-side). Run in a loop every 5 min from a laptop / EC2 / anything with connectivity while you fix the dispatcher.

Selective: `ONLY=sui-community-pool,paper-trader bun run scripts/ping-crons.ts`.

## Step 4 — Deploy-side: routes all returning 5xx

If Vercel is up but every cron route 500s, an unhandled throw at module-load time (e.g., a broken import) will kill every route uniformly.

- Check the last 5 deploys: `gh api repos/ZkVanguard/ZKward/deployments --paginate | jq '.[] | {sha, created_at, environment}' | head -30`
- If a deploy landed within a few minutes of the outage start, that's the suspect. Roll back on Vercel dashboard or by re-deploying an earlier SHA.
- Or `vercel logs --project zkward --since 30m` for the actual error trace.

## Step 5 — Re-add missing schedules

If dispatcher lost its schedule state, re-register each cron. Template:
```
curl -sS -X POST https://jobs.zkward.com/v1/schedules \
  -H "Authorization: Bearer $JOBS_PUBLISH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "polymarket-edge-trader",
    "cron": "*/5 * * * *",
    "target": "https://www.zkward.com/api/cron/polymarket-edge-trader",
    "method": "GET",
    "signingSecret": "'$JOBS_SIGNING_SECRET'"
  }'
```

Repeat for each entry in CLAUDE.md's cron inventory table. Verify by:
```
curl -sS -H "Authorization: Bearer $JOBS_PUBLISH_TOKEN" \
  https://jobs.zkward.com/v1/schedules | jq 'length'
```

## Step 6 — Post-incident checklist

Once crons are firing again:

1. Run `bun run scripts/ping-crons.ts` to confirm every route returns 200.
2. Query `cron_state` for fresh `lastRun` timestamps (all should be within the expected cadence).
3. Check the `heartbeat-monitor` Discord alert — should have gone silent within 30 min.
4. Clear any halt flags that fired defensively during the outage:
   ```sql
   SELECT key, value::text FROM cron_state
   WHERE key LIKE 'cron:haltUntil:%' AND value::text::bigint > extract(epoch from now())*1000;
   ```
   Use `POST /api/admin/clear-cron-halt` to clear each (CRON_SECRET-gated, per `memory/reference_admin_clear_cron_halt.md`).
5. **Root-cause the dispatcher failure.** Silent 24-hour outages are unacceptable. Fix whatever let the worker die + not restart. Document in `memory/project_<incident>_yyyy_mm_dd.md`.

## Prevention (already shipped as part of this pass)

- **`/api/cron/heartbeat-monitor`** — cron that watches other crons, fires a Discord KILL if any cron is > 3× its expected cadence stale. See its own JSDoc for the cadence table. Schedule it from `jobs.zkward.com` at 5-min cadence, same as every other cron.
- **`scripts/ping-crons.ts`** — operator-run fallback. When you spot silence (or the heartbeat-monitor itself is silent), run this to hit every cron route directly with `CRON_SECRET` and see which are alive.

**Accepted trade-off:** `jobs.zkward.com` is the single cron platform. If the jobs service itself dies, the heartbeat-monitor can't fire — that's the outage class where `scripts/ping-crons.ts` (run by an operator or by whatever process manager owns the jobs host) is the recovery path. No external SaaS to compensate — we run our own everything.
