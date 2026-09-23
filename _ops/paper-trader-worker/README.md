# paper-trader-worker

Standalone paper-trader tick that runs on Bakchodi (or any Linux with
systemd + bun). Replaces the Vercel cron route that got fair-use-blocked
2026-09-23.

## Why this exists

Vercel Hobby tier hit fair-use limits on 2026-09-23 with 15+ crons
firing every 2-30 min. Moving the paper-trader off Vercel restores the
invocation budget for user-facing routes (dashboard, chat, aggregator
API) and gives the trader a durable home that isn't tied to a serverless
billing quota.

## Setup — one-time, ~15 min

You have cloudflared configured for `ssh.zkward.com`. From your laptop:

```bash
# 1. SSH into Bakchodi
cloudflared access ssh --hostname ssh.zkward.com
# (or however you already SSH in)

# 2. On the server, run the installer
sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/ZkVanguard/ZKward/main/services/paper-trader-worker/install.sh)"
# It'll get to step 7/8 and stop, asking for .env.

# 3. Create the .env with the same DB URL Vercel had
sudo -u zkward tee /opt/zkward-worker/.env >/dev/null <<'EOF'
DATABASE_URL=postgresql://zkward:PASSWORD_HERE@localhost:6432/bakchodi?sslmode=disable
# Add any other env the trader touches transitively:
#   CRYPTO_COM_API_KEY, DELPHI_API_KEY, etc.
# Copy from the Vercel dashboard's env vars page for reference.
EOF
sudo chmod 600 /opt/zkward-worker/.env

# 4. Enable + start the timer
sudo systemctl enable --now paper-trader-worker.timer
```

## Verify it's ticking

```bash
# Timer state (should show "active (waiting)")
systemctl status paper-trader-worker.timer

# Live logs from the service
journalctl -u paper-trader-worker.service -f

# Manual tick for testing (skips the timer)
sudo systemctl start paper-trader-worker.service
```

Or from your laptop, via prod DB:

```sql
-- Should show a recent cron:lastRun heartbeat (< 6 min)
SELECT REPLACE(key, 'cron:lastRun:', '') AS cron,
       ROUND(EXTRACT(EPOCH FROM (NOW() - to_timestamp((value::text)::bigint / 1000))) / 60) AS mins_ago
FROM cron_state
WHERE key IN ('cron:lastRun:paper-trader', 'cron:lastRun:paper-gated-trader');
```

## Update to a new commit

The installer's step 3 does a hard reset to `origin/main`. To pick up
new fixes:

```bash
sudo systemctl stop paper-trader-worker.timer
sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/ZkVanguard/ZKward/main/services/paper-trader-worker/install.sh)"
sudo systemctl start paper-trader-worker.timer
```

## Rollback / disable

```bash
sudo systemctl disable --now paper-trader-worker.timer
```

The `.env` and the checkout stay in place, so re-enabling is instant.

## Failure modes + what to check

| Symptom | Check | Fix |
|---|---|---|
| Timer active but no tick logs | `bun --version` on the server | Re-run installer (bun path may be missing) |
| Tick starts but throws pg error | `.env`'s `DATABASE_URL` | Confirm the local Bakchodi socket matches (should be localhost:6432 with sslmode=disable) |
| Tick starts but no signal data | `.env` missing aggregator keys | Copy the full Vercel env; the aggregator has ~10 optional signal keys |
| Tick runs but no trades open | Normal! | Signal gates + streak-guards can refuse many ticks in a row |

## Architecture note

This worker runs `PaperTrader.runTick()` + `PaperGatedTrader.runTick()`
in a single Node process, once per invocation, then exits. All shared
state (positions, stats, bandit, calibrator) lives in the Bakchodi
Postgres `cron_state` table — identical to what the Vercel version
wrote. Reading + writing are localhost hops on Bakchodi = fast + free.

The same tick logic still runs unchanged; only the invocation surface
moved from Vercel routes → systemd timer.

## Not yet migrated (still on Vercel — will fail 402 until unblocked)

- `polymarket-edge-trader` cron (live BlueFin trader — currently
  offline anyway per user decision)
- `sui-community-pool` (SUI pool NAV attestation)
- `bluefin-health`, `alert-response-loop`, `agent-signal-tick`, etc.

Migrate these later using the same pattern: add a
`scripts/{cron-name}-worker.ts` entry point, a systemd unit + timer,
and update this installer to install all of them.
