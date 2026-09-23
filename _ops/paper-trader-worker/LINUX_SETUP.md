# Paper-trader worker — Linux setup runbook

Complete step-by-step for setting up the standalone paper-trader on a
Linux server (Bakchodi or any modern systemd host). Written to be
copy-paste-able top to bottom.

**Time budget:** ~15 minutes total on first run. Updates are one command.

---

## 0. Prereqs — read this before you SSH

**On the server (Bakchodi):**
- Linux with systemd (Ubuntu 22.04+, Debian 12+, Fedora 39+ all fine)
- sudo access
- Outbound HTTPS (github.com, bun.sh, prediction-market APIs)
- Postgres 17 running locally on port 6432 with the `bakchodi` database
- ~500 MB free disk for the repo checkout + `node_modules`

**On your laptop:**
- `cloudflared` installed and authenticated
- Access to the Vercel dashboard (to copy env vars over)
- The Bakchodi Postgres password (grab from the current Vercel
  `DATABASE_URL` env var)

**What this does NOT need:**
- Docker / Kubernetes
- Root-only access — the systemd unit runs as unprivileged `zkward` user
- A domain / TLS / reverse proxy — the worker doesn't listen on any port

---

## 1. SSH into Bakchodi

You have cloudflared configured for `ssh.zkward.com`. From your laptop:

```bash
# If not already set up in ~/.ssh/config with cloudflared ProxyCommand:
cloudflared access ssh --hostname ssh.zkward.com

# Or if you have the shortcut in ~/.ssh/config:
ssh ssh.zkward.com
```

You should land on the Bakchodi shell as your user (probably `mrare` or
similar). Confirm with `whoami` and `hostname`.

---

## 2. Run the installer

Copy-paste this whole block into the Bakchodi shell:

```bash
sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/ZkVanguard/ZKward/main/services/paper-trader-worker/install.sh)"
```

The installer runs through 8 steps and will stop at step 7 asking you
to create `/opt/zkward-worker/.env`. That is intentional — secrets
never live in git.

What each step does:

| Step | Action | If it fails |
|---|---|---|
| 1 | Create `zkward` system user | `useradd` needs sudo — re-run with `sudo` |
| 2 | Create `/opt/zkward-worker` | Only fails if `/opt` is read-only |
| 3 | Clone repo (shallow depth=1) | Check outbound HTTPS to github.com |
| 4 | Install bun to `/usr/local/bin/bun` | Falls back to `curl` — check bun.sh reachable |
| 5 | `bun install --frozen-lockfile` | 2-5 min first time; network-heavy |
| 6 | Copy `.service` + `.timer` into `/etc/systemd/system/` | Needs sudo |
| 7 | **STOP** — waits for you to create `.env` (see step 3 below) | — |
| 8 | Enable + start timer | Only runs if `.env` exists |

If step 7 stops you, that's expected. Continue to the next section.

---

## 3. Create the `.env` file

The trader needs at least `DATABASE_URL`. Copy everything else from
Vercel to be safe — the aggregator has optional keys that boost signal
coverage.

**Grab the current Vercel env vars** (from your laptop, not the
server):

```bash
# On your laptop
cd ~/OneDrive/Documents/Zk-Vanguard   # or wherever the repo lives
vercel env pull /tmp/vercel-prod.env --environment=production --yes
# Then scp it to Bakchodi:
scp /tmp/vercel-prod.env ssh.zkward.com:/tmp/
```

If you don't have Vercel CLI installed on the laptop, just build the
`.env` manually with the minimum:

```bash
# On Bakchodi
sudo -u zkward tee /opt/zkward-worker/.env >/dev/null <<'EOF'
# ── REQUIRED ─────────────────────────────────────────────────
# Bakchodi Postgres. localhost:6432 is the PgBouncer socket that
# jobs.zkward.com already uses. sslmode=disable is fine over
# loopback; use require for anything crossing a network.
DATABASE_URL=postgresql://zkward:PASSWORD_HERE@localhost:6432/bakchodi?sslmode=disable

# ── STRONGLY RECOMMENDED (aggregator signal coverage) ────────
# Without these the aggregator falls back to public unauth endpoints,
# which are heavily rate-limited. Signal count drops 30-50%.
CRYPTO_COM_API_KEY=
POLYMARKET_API_KEY=
DELPHI_API_KEY=
KALSHI_API_KEY=
BINANCE_API_KEY=

# ── OPTIONAL PAPER TRADER TUNING (defaults are sensible) ─────
# Uncomment + edit to override. Restart timer to apply.
# PAPER_TRADER_MAX_HOLD_MIN=240
# PAPER_TRADER_MAX_STAKE_PCT=0.03
# PAPER_TRADER_MIN_CONFIDENCE=62
# PAPER_TRADER_MIN_CONSENSUS=60
# PAPER_TRADER_MIN_SOURCES=3
# PAPER_TRADER_ASSET_STREAK_LOSS_COUNT=4
# PAPER_TRADER_ASSET_STREAK_COOLDOWN_HOURS=2
# PAPER_TRADER_TIGHTEN_AGE_MIN=30
# PAPER_TRADER_TIGHTEN_LOSS_USD=50

# ── OPTIONAL (source calibrator + decay) ─────────────────────
# SOURCE_CALIBRATOR_PRIOR=5
# SOURCE_CALIBRATOR_KILL_THRESHOLD=0.40
# SOURCE_CALIBRATOR_KILL_MIN_TRADES=15

# ── OPTIONAL (alerting) ──────────────────────────────────────
# DISCORD_WEBHOOK_URL=  # for TRADE/KILL notifications
EOF

# Lock down the file — contains secrets
sudo chmod 600 /opt/zkward-worker/.env
sudo chown zkward:zkward /opt/zkward-worker/.env
```

**Get the DATABASE_URL password:** on your laptop, the current password
lives in the Vercel dashboard → project → Settings → Environment
Variables → `DATABASE_URL`. Click the eye icon to reveal. Or if you
have `.env.local` from an earlier `vercel env pull`, grep it there.

---

## 4. Enable the timer

Back on Bakchodi:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now paper-trader-worker.timer
```

That's it. Timer fires the first tick 1 minute after enable, then every
5 minutes forever.

---

## 5. Verify it's actually ticking

Three ways, in order of quickest → most authoritative:

### 5a. Systemd status

```bash
systemctl status paper-trader-worker.timer
# Expected: "active (waiting)"

systemctl list-timers paper-trader-worker.timer
# Shows the next scheduled fire — should be < 5 min away
```

### 5b. Live logs

```bash
journalctl -u paper-trader-worker.service -f
```

Wait up to 5 min. You should see log lines like:

```
[worker] tick start { pid: 12345, node: 'bun-1.3.5' }
[PredictionAggregator] Best opportunity selected { asset: 'BTC', ... }
[worker] PaperTrader tick complete { result: { action: 'held', ... } }
[worker] PaperGatedTrader tick complete { result: { action: 'held', ... } }
[worker] tick done { durationMs: 5844, ok: true }
```

A normal tick takes 3-8 seconds. Actions:
- `held` — trader has an active position and holding
- `opened` — new position opened
- `closed` — active position closed
- `skipped` — no candidate cleared the gates this tick

### 5c. Prod DB heartbeat

From your laptop:

```bash
DB="postgresql://zkward:PASSWORD@pg.zkward.com:6432/bakchodi?sslmode=require"

# Should show a value < 6 for both traders
psql "$DB" -c "
SELECT REPLACE(key, 'cron:lastRun:', '') AS cron,
       ROUND(EXTRACT(EPOCH FROM (NOW() - to_timestamp((value::text)::bigint / 1000))) / 60) AS mins_ago
FROM cron_state
WHERE key IN ('cron:lastRun:paper-trader', 'cron:lastRun:paper-gated-trader');
"
```

If `mins_ago > 10`, something is stuck — see troubleshooting.

---

## 6. Daily monitoring — 30-second check

Bookmark this. Run daily / whenever you check the paper trader.

```bash
# On your laptop
DB="postgresql://zkward:PASSWORD@pg.zkward.com:6432/bakchodi?sslmode=require"

psql "$DB" <<'SQL'
-- 1. Trader ticking recently?
SELECT REPLACE(key, 'cron:lastRun:', '') AS cron,
       ROUND(EXTRACT(EPOCH FROM (NOW() - to_timestamp((value::text)::bigint / 1000))) / 60) AS mins_ago
FROM cron_state
WHERE key IN ('cron:lastRun:paper-trader', 'cron:lastRun:paper-gated-trader');

-- 2. Recent closed trades — win rate + PnL last 24h
SELECT
  COUNT(*) AS closed_24h,
  COUNT(*) FILTER (WHERE current_pnl > 0) AS wins,
  ROUND(100.0 * COUNT(*) FILTER (WHERE current_pnl > 0) / NULLIF(COUNT(*), 0), 1) AS win_pct,
  ROUND(SUM(current_pnl)::numeric, 2) AS pnl_24h,
  ROUND(AVG(EXTRACT(EPOCH FROM (closed_at - created_at)) / 60)::numeric, 1) AS avg_hold_min
FROM hedges
WHERE portfolio_id IN (-3, -4)
  AND status = 'closed'
  AND closed_at > NOW() - INTERVAL '24 hours';

-- 3. Active positions right now
SELECT id, portfolio_id, asset, side,
       to_char(created_at AT TIME ZONE 'UTC', 'HH24:MI') AS opened_utc,
       ROUND(EXTRACT(EPOCH FROM (NOW() - created_at)) / 60) AS held_min
FROM hedges
WHERE portfolio_id IN (-3, -4) AND status = 'active'
ORDER BY id;
SQL
```

---

## 7. Update to a new commit

The trader picks up code changes when the systemd service restarts,
which happens implicitly each time the timer fires (oneshot units
re-exec cleanly). But new dependencies or file additions require
re-installing.

**Fast path — no new deps:**

```bash
# On Bakchodi
cd /opt/zkward-worker
sudo -u zkward git fetch --depth=1 origin main
sudo -u zkward git reset --hard origin/main
# Next timer fire (up to 5 min) will pick up the new code
```

**Full path — deps changed:**

```bash
# On Bakchodi
sudo systemctl stop paper-trader-worker.timer
sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/ZkVanguard/ZKward/main/services/paper-trader-worker/install.sh)"
sudo systemctl start paper-trader-worker.timer
```

The installer is idempotent — safe to re-run any time.

---

## 8. Rollback / disable

```bash
sudo systemctl disable --now paper-trader-worker.timer
```

The service unit stays installed, `.env` is untouched, checkout stays
intact. Re-enable any time with:

```bash
sudo systemctl enable --now paper-trader-worker.timer
```

To fully remove:

```bash
sudo systemctl disable --now paper-trader-worker.timer
sudo rm /etc/systemd/system/paper-trader-worker.{service,timer}
sudo systemctl daemon-reload
sudo rm -rf /opt/zkward-worker
sudo userdel zkward
```

---

## 9. Troubleshooting

| Symptom | First check | Fix |
|---|---|---|
| Timer shows "active (waiting)" but no tick logs | `sudo systemctl start paper-trader-worker.service` (manual fire); check `journalctl -u paper-trader-worker.service --since='10 min ago'` | If `bun: command not found`, re-run installer. If import errors, `bun install` in `/opt/zkward-worker` |
| Timer shows "inactive (dead)" | `systemctl is-enabled paper-trader-worker.timer` | `sudo systemctl enable --now paper-trader-worker.timer` |
| Tick logs show `pg` connection errors | Test connection: `psql "$DATABASE_URL"` as the zkward user | Check `.env` `DATABASE_URL` — port is 6432 (PgBouncer), not 5432 (direct Postgres) |
| Tick starts but no `PredictionAggregator` logs | Aggregator API calls failing | Check outbound HTTPS. Public API keys often work unauthed; auth'd keys need to be in `.env` |
| Tick logs show `[worker] fatal` | Read the stack trace in journalctl | Usually a missing env var or a code bug; check `git log --oneline -3` in `/opt/zkward-worker` matches origin/main |
| Everything runs but no trades open | Look for `skipped` results with reasons | Normal — signal-quality gate, streak-guard, majority filter, trend-guard can all refuse. Check DB `paper-trader:last-skip` for the current reason |
| DB DATABASE_URL keeps rotating passwords | Vercel rotates on manual event | Update `/opt/zkward-worker/.env` + `sudo systemctl restart paper-trader-worker.service` |
| System load spikes during ticks | `top` during a tick — bun should peak <100% CPU for 5s | Fine; if tick takes >30s consistently, add `PAPER_TRADER_MAX_CONCURRENT=1` to `.env` to reduce work per tick |

**Verbose debugging** — run a tick manually with full logs:

```bash
sudo -u zkward bash -c "cd /opt/zkward-worker && bun run scripts/paper-trader-worker.ts" 2>&1 | tee /tmp/trader-tick.log
# Then examine /tmp/trader-tick.log
```

---

## 10. Env vars — full reference

### Required

| Var | Purpose | Default |
|---|---|---|
| `DATABASE_URL` | Bakchodi Postgres connection string | none — MUST set |

### Aggregator (strongly recommended)

Copy from Vercel `production` env. Public prediction market APIs mostly
work unauth but rate limits will bite. Signal count drops 30-50%
without these.

| Var | Purpose |
|---|---|
| `CRYPTO_COM_API_KEY` | Crypto.com signal (BTC/ETH 24h) |
| `POLYMARKET_API_KEY` | Polymarket authenticated queries |
| `DELPHI_API_KEY` | Delphi predictions |
| `KALSHI_API_KEY` | Kalshi resolved-market filter |
| `BINANCE_API_KEY` | Orderbook depth + long-short ratio |

### Paper trader tuning (defaults are calibrated)

| Var | Default | Effect |
|---|---|---|
| `PAPER_TRADER_MAX_HOLD_MIN` | 240 | Base max hold before force-close (min) |
| `PAPER_TRADER_MAX_STAKE_PCT` | 0.03 | Max notional as % of NAV |
| `PAPER_TRADER_LEVERAGE` | 3 | Applied to notional |
| `PAPER_TRADER_MIN_CONFIDENCE` | 62 | Aggregate confidence entry gate |
| `PAPER_TRADER_MIN_CONSENSUS` | 60 | Source consensus entry gate |
| `PAPER_TRADER_MIN_SOURCES` | 3 | Minimum signal sources for a candidate |
| `PAPER_TRADER_STOP_LOSS_PCT` | 0.02 | Adaptive stop base |
| `PAPER_TRADER_TRAILING_ARM_PCT` | 0.01 | MFE threshold to arm trailing (fraction of NAV) |
| `PAPER_TRADER_TRAILING_GIVEBACK_PCT` | 0.5 | Give-back fraction that fires trailing |
| `PAPER_TRADER_MAX_CONCURRENT` | 3 | Max simultaneous open positions |
| `PAPER_TRADER_MIN_FLIP_AGE_SEC` | 180 | Min position age before signal-flip can close |
| `PAPER_TRADER_MIN_FLIP_CONFIDENCE` | 65 | Confidence bar for flip-close |
| `PAPER_TRADER_ASSET_STREAK_LOSS_COUNT` | 4 | Losses on ANY side of asset → cooldown |
| `PAPER_TRADER_ASSET_STREAK_COOLDOWN_HOURS` | 2 | Cooldown duration |
| `PAPER_TRADER_TIGHTEN_AGE_MIN` | 30 | Min age before underwater-tighten fires |
| `PAPER_TRADER_TIGHTEN_LOSS_USD` | 50 | Loss threshold for tighten |
| `PAPER_TRADER_TIGHTEN_LOSS_PCT` | 0.0002 | Loss as %NAV threshold for tighten |

### Source calibrator

| Var | Default | Effect |
|---|---|---|
| `SOURCE_CALIBRATOR_PRIOR` | 5 | Bayesian shrinkage strength (higher = more conservative) |
| `SOURCE_CALIBRATOR_KILL_THRESHOLD` | 0.40 | Hit rate below this → auto-kill weight × 0.05 |
| `SOURCE_CALIBRATOR_KILL_MIN_TRADES` | 15 | Min observations before kill can fire |

### Alerting

| Var | Purpose |
|---|---|
| `DISCORD_WEBHOOK_URL` | Discord webhook for TRADE/KILL notifications. Optional — no webhook = no alerts, trader still runs. |

---

## 11. Architecture reference

### What runs where

| Component | Runs on | Cadence |
|---|---|---|
| Paper trader (`PaperTrader.runTick`) | **Bakchodi systemd** (this worker) | 5 min |
| Paper gated trader (`PaperGatedTrader.runTick`) | **Bakchodi systemd** (this worker) | 5 min |
| Signal aggregator | Called in-process by worker | On demand |
| Source calibrator, bandit, streak-guard | Called in-process by worker | On demand |
| Dashboard, chat AI, aggregator API | Vercel routes | On demand (user traffic) |
| SUI pool cron, hedge reconcile, live trader | **Vercel routes** (still) | Various |

Only the paper trader has been moved off Vercel so far. Other crons
still fire via `jobs.zkward.com` → Vercel routes. If Vercel stays fair-
use-blocked, migrate them one at a time using this same pattern.

### Data flow

```
+-------------+       +---------------------+       +-------------------+
| systemd     |----->| /opt/zkward-worker/  |----->| Bakchodi Postgres |
| timer 5min  |      | scripts/paper-       |       | (localhost:6432)  |
+-------------+      | trader-worker.ts     |       +-------------------+
                     +---------------------+
                              |
                              v
                     +---------------------+
                     | External APIs       |
                     | Polymarket / Kalshi |
                     | Delphi / Manifold   |
                     | Binance / Bybit     |
                     | Deribit / crypto.com|
                     +---------------------+
```

### File layout after install

```
/opt/zkward-worker/
├── .env                                    # secrets, 0600, owned by zkward
├── scripts/
│   └── paper-trader-worker.ts             # entry point
├── services/paper-trader-worker/           # systemd artifacts (source)
│   ├── paper-trader-worker.service
│   ├── paper-trader-worker.timer
│   ├── install.sh
│   ├── LINUX_SETUP.md                     # this file
│   └── README.md
├── lib/                                    # shared code
│   ├── services/paper-trader/             # trader logic
│   ├── services/market-data/              # aggregator
│   └── db/                                 # postgres pool
└── node_modules/                          # bun install output
```

The systemd unit files at `/etc/systemd/system/paper-trader-worker.{service,timer}`
are copies (not symlinks) of the versions under `services/paper-trader-worker/`.
An update pulls new versions in the repo AND re-copies them in step 6.

---

## 12. Future migrations — other crons

When you're ready to move more crons off Vercel, follow this pattern:

1. Add `scripts/{cron-name}-worker.ts` that imports and calls the
   cron's core logic (analog of `runTick()`).
2. Add `services/{cron-name}-worker/{service,timer,install.sh}` — copy
   from `paper-trader-worker/` and adjust names + cadence.
3. Extend `install.sh` to install all workers OR keep them as
   independent installers.
4. Test locally: `DATABASE_URL=... bun run scripts/{name}-worker.ts`.
5. Deploy to Bakchodi via the installer.

Prioritize by fair-use impact:

| Cron | Cadence | Daily invocations | Priority |
|---|---|---|---|
| `polymarket-edge-trader` | 5 min | 288 | HIGH (biggest signal + trader) |
| `sui-community-pool` | 30 min | 48 | MED (SUI-only path) |
| `bluefin-health` | 5 min | 288 | MED |
| `alert-response-loop` | 15 min | 96 | LOW |
| `agent-signal-tick` | 2 min | 720 | HIGH (highest volume) |

---

## Common gotchas — read once

- **Bun version:** the installer pulls the latest bun. If a later
  version breaks something, pin with:
  ```bash
  curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.5"
  ```
- **Timezone:** systemd uses UTC by default. Journal timestamps in
  `journalctl` are local. Pass `-o short-utc` to see UTC-matched to DB.
- **NTP drift:** if the server clock drifts >5 min, cron_state
  heartbeats look stale even when the trader ticked. `sudo timedatectl
  status` — should show "System clock synchronized: yes".
- **`.env` reload:** systemd loads `EnvironmentFile` at service start,
  not at timer fire. Update the file → `sudo systemctl restart
  paper-trader-worker.service` to force reload before next tick.
- **Log volume:** default `journalctl` retention is 4 weeks. If disk
  gets tight: `sudo journalctl --vacuum-time=7d`.
- **DB pool exhaustion:** if you also run other workers hitting the
  same PG, watch `SELECT count(*) FROM pg_stat_activity WHERE
  application_name LIKE 'zkv-%';`. Above 40 = tune per-worker `max`
  in `lib/db/postgres.ts`.

---

## Where to escalate

- Paper trader logic bugs → this repo, tag `@paper-trader`
- Systemd unit errors → `journalctl -u paper-trader-worker.service`
  first, then repo issue
- DB access issues → Bakchodi ops (self-hosted; user is on-call)
- Signal quality drops → check the aggregator's per-source hit rates
  via `psql`:
  ```sql
  SELECT REPLACE(key, 'trader:source-cal:', '') AS src,
         (value::jsonb ->> 'wins')::int AS wins,
         (value::jsonb ->> 'n')::int AS n,
         ROUND(100.0 * (value::jsonb ->> 'wins')::float
               / NULLIF((value::jsonb ->> 'n')::int, 0), 1) AS hit_pct
  FROM cron_state WHERE key LIKE 'trader:source-cal:%'
    AND (value::jsonb ->> 'n')::int >= 15
  ORDER BY hit_pct DESC LIMIT 20;
  ```
