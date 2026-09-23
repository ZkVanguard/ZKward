#!/usr/bin/env bash
# ZKward multi-cron workers — installs the systemd template + all
# per-cron timers on Bakchodi. Idempotent; safe to re-run.
#
# Assumes /opt/zkward-worker already exists (installed by
# services/paper-trader-worker/install.sh). If not, run that first.
#
#   sudo bash services/cron-workers/install.sh
set -euo pipefail

INSTALL_DIR=/opt/zkward-worker
SYSTEMD_DIR=/etc/systemd/system
SERVICE_USER=zkward

# List of cron names to install timers for. Add to this list to enable
# more crons; remove to disable. Names MUST match a directory under
# app/api/cron/ AND be in KNOWN_CRONS in scripts/vercel-cron-worker.ts.
CRONS=(
  sui-community-pool
  sui-hedge-reconcile
  sui-collect-fees
  polymarket-edge-trader
  agent-signal-tick
  alert-response-loop
  bluefin-health
  bluefin-db-reconcile
  pool-nav-monitor
  liquidation-guard
  poly-discover
)

log() { echo "[install] $*" >&2; }
fail() { echo "[install] ERROR: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "run with sudo"
[ -d "$INSTALL_DIR" ] || fail "$INSTALL_DIR not found — run services/paper-trader-worker/install.sh first"
[ -f "$INSTALL_DIR/.env" ] || fail "$INSTALL_DIR/.env not found — see services/cron-workers/README.md"

log "installing systemd template unit"
install -m 644 "$INSTALL_DIR/services/cron-workers/zkward-cron@.service" "$SYSTEMD_DIR/"

log "installing timers for ${#CRONS[@]} crons"
for cron in "${CRONS[@]}"; do
  TIMER_FILE="$INSTALL_DIR/services/cron-workers/zkward-cron@${cron}.timer"
  if [ ! -f "$TIMER_FILE" ]; then
    log "  SKIP $cron — no timer file at $TIMER_FILE"
    continue
  fi
  install -m 644 "$TIMER_FILE" "$SYSTEMD_DIR/"
  log "  + zkward-cron@${cron}.timer"
done

systemctl daemon-reload

log "enabling + starting timers"
for cron in "${CRONS[@]}"; do
  TIMER_NAME="zkward-cron@${cron}.timer"
  if [ ! -f "$SYSTEMD_DIR/$TIMER_NAME" ]; then continue; fi
  systemctl enable --now "$TIMER_NAME" 2>&1 | grep -v "^Created symlink" || true
done

log "done."
log ""
log "verify with:"
log "  systemctl list-timers 'zkward-cron@*'"
log "  journalctl -t 'zkward-cron-*' -n 40 --no-pager"
log ""
log "IMPORTANT: disable the corresponding Vercel crons via jobs.zkward.com"
log "before these timers fire, to avoid double-invocation. See:"
log "  services/cron-workers/README.md § 'Prevent double-fire'"
