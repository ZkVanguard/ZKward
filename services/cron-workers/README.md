# cron-workers — all Vercel crons off Vercel

Companion to `services/paper-trader-worker/`. Migrates the remaining
10 scheduled Vercel cron routes to Bakchodi systemd timers using
**one generic worker + a systemd template unit + per-cron timers**.

## Architecture

```
                                     ┌─ zkward-cron@sui-community-pool.timer      → every 30 min
                                     ├─ zkward-cron@sui-hedge-reconcile.timer     → every 1 h
                                     ├─ zkward-cron@sui-collect-fees.timer        → daily 12:00 UTC
                                     ├─ zkward-cron@polymarket-edge-trader.timer  → every 5 min
                                     ├─ zkward-cron@agent-signal-tick.timer       → every 2 min
                                     ├─ zkward-cron@alert-response-loop.timer     → every 15 min
                systemd timers ────► ├─ zkward-cron@bluefin-health.timer          → every 5 min
                                     ├─ zkward-cron@bluefin-db-reconcile.timer    → every 15 min
                                     ├─ zkward-cron@pool-nav-monitor.timer        → every 15 min
                                     ├─ zkward-cron@liquidation-guard.timer       → every 10 min
                                     └─ zkward-cron@poly-discover.timer           → every 5 min

                                                        │
                                                        ▼
                              zkward-cron@%i.service (template unit)
                                                        │
                                                        ▼
                              bun run scripts/vercel-cron-worker.ts %i
                                                        │
                                                        ▼
                        Dynamic import: app/api/cron/%i/route.ts
                                                        │
                                                        ▼
                         GET(synthetic NextRequest with CRON_SECRET)
                                                        │
                                                        ▼
                       Same code path as the Vercel version ran
```

**No route refactor.** The worker invokes the exact same `GET` handler
Vercel invoked; only the caller changed.

## Setup

### Prereqs

- Paper-trader worker installed first (`services/paper-trader-worker/install.sh`)
- `/opt/zkward-worker/.env` populated with:
  - `DATABASE_URL` (Bakchodi PG, localhost:6432)
  - `CRON_SECRET` (matches what Vercel had — copy from Vercel prod env)
  - Per-cron env vars (see below)

### Env vars per cron

Copy from Vercel prod. The generic ones (aggregator API keys, DB, etc.)
apply to most crons; the ones below are cron-specific:

| Cron | Additional env |
|---|---|
| `sui-community-pool` | `SUI_POOL_ADMIN_KEY`, `SUI_NETWORK=mainnet`, `NEXT_PUBLIC_SUI_MAINNET_USDC_POOL_PKG`, `NEXT_PUBLIC_SUI_MAINNET_USDC_POOL_STATE`, `ORACLE_CAP_ID` |
| `sui-hedge-reconcile` | `SUI_POOL_ADMIN_KEY`, `BLUEFIN_ACCOUNT_KEY` |
| `sui-collect-fees` | `SUI_POOL_ADMIN_KEY` |
| `polymarket-edge-trader` | `BLUEFIN_ACCOUNT_KEY`, `POLYMARKET_*` |
| `bluefin-health`, `bluefin-db-reconcile` | `BLUEFIN_ACCOUNT_KEY` |
| others | Usually just DB + aggregator keys |

**Do `vercel env pull /tmp/vercel.env --environment=production --yes`**
from your laptop, scp to Bakchodi, then use it as the source of truth
for `/opt/zkward-worker/.env`.

### Install

```bash
# On Bakchodi (after paper-trader-worker is installed)
sudo bash /opt/zkward-worker/services/cron-workers/install.sh
```

The installer:
1. Copies the template unit `zkward-cron@.service` to `/etc/systemd/system/`
2. Copies the 11 per-cron timers
3. `systemctl daemon-reload`
4. `enable --now` each timer

First tick fires 90s-6min after enable (varies per cron's OnBootSec).

## Prevent double-fire

**CRITICAL:** disable the corresponding Vercel-cron schedules on
`jobs.zkward.com` BEFORE these timers start firing. If both fire the
same route, the distributed lock (`tryClaimCronRun`) inside each route
will reject one of the two — but you'll waste effort AND if the lock
window is exceeded, you get double-execution.

Inspect current jobs.zkward.com schedules:
```bash
curl -H "Authorization: Bearer $JOBS_PUBLISH_TOKEN" $JOBS_URL/v1/schedules
```

Disable each one:
```bash
curl -X DELETE -H "Authorization: Bearer $JOBS_PUBLISH_TOKEN" \
  "$JOBS_URL/v1/schedules/<schedule-id>"
```

Or via the jobs service admin UI if one exists.

## Verify

### Timer list

```bash
systemctl list-timers 'zkward-cron@*' --all
```

Should show all 11 timers, each with a next-fire time within the next
cadence window.

### Live logs

```bash
# All cron workers
journalctl -t 'zkward-cron-*' -f

# One specific cron
journalctl -u zkward-cron@sui-community-pool.service -f
```

### DB heartbeats

From laptop:
```sql
SELECT REPLACE(key, 'cron:lastRun:', '') AS cron,
       ROUND(EXTRACT(EPOCH FROM (NOW() - to_timestamp((value::text)::bigint / 1000))) / 60) AS mins_ago
FROM cron_state
WHERE key LIKE 'cron:lastRun:%'
  AND jsonb_typeof(value) = 'number'
ORDER BY (value::text)::bigint DESC;
```

Every scheduled cron should show `mins_ago` less than its cadence.

## Enable/disable individual crons

```bash
# Disable one cron temporarily
sudo systemctl disable --now zkward-cron@polymarket-edge-trader.timer

# Re-enable
sudo systemctl enable --now zkward-cron@polymarket-edge-trader.timer

# Manually fire one for testing
sudo systemctl start zkward-cron@sui-community-pool.service
# Then check the exit + logs:
sudo systemctl status zkward-cron@sui-community-pool.service
```

## Add a new cron

1. Confirm `app/api/cron/<new-name>/route.ts` exists and exports `GET`
2. Add `<new-name>` to `KNOWN_CRONS` in `scripts/vercel-cron-worker.ts`
3. Create `services/cron-workers/zkward-cron@<new-name>.timer` with
   the desired cadence
4. Add `<new-name>` to the `CRONS` array in `install.sh`
5. Re-run installer

## Remove/disable a cron entirely

Remove from `CRONS` array in `install.sh`. Re-run installer only
installs new ones — leaves existing timers alone. To disable
in-place:

```bash
sudo systemctl disable --now zkward-cron@<name>.timer
sudo rm /etc/systemd/system/zkward-cron@<name>.timer
sudo systemctl daemon-reload
```

## Rollback all cron workers

```bash
for t in $(systemctl list-timers 'zkward-cron@*' --all --no-legend | awk '{print $NF}'); do
  sudo systemctl disable --now "$t"
done
sudo rm /etc/systemd/system/zkward-cron@*.timer
sudo rm /etc/systemd/system/zkward-cron@.service
sudo systemctl daemon-reload
```

Then re-enable the corresponding jobs.zkward.com Vercel schedules.

## Troubleshooting

| Symptom | Check | Fix |
|---|---|---|
| Timer active but no journal entries | `systemctl list-timers zkward-cron@<name>.timer` — is Next expected? | If Next is 5+ min past, `systemctl start zkward-cron@<name>.service` manually |
| GET throws — `cannot find module` | `KNOWN_CRONS` doesn't include the name OR route file doesn't exist | Add to `KNOWN_CRONS` or fix path |
| 401 in logs | `CRON_SECRET` mismatch between `.env` and Vercel | Copy the exact value from Vercel |
| 429 in logs (rate limit) | Normal — distributed lock refused a too-soon retry | Ignore; means the tick already fired recently |
| 500 with `SUI_POOL_ADMIN_KEY` error | Key missing or malformed in `.env` | Grab from Vercel; must be `suiprivkey…` or 64-char hex |
| Multiple crons all timing out at 5min | Bakchodi DB pool exhausted or slow | Check `SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'zkv-%';` |

## Cost of running all workers

At full cadence: ~15 tick fires per hour across all crons. Each tick
is 3-30 seconds on Bakchodi (localhost DB = fast). Peak CPU is
~20-40% on one core during overlapping ticks. Memory is bounded
because each tick is a fresh `bun` process that exits.

Disk: journal grows ~50 MB/week at INFO logging. Rotate weekly:
`sudo journalctl --vacuum-time=7d`.
