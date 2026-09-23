#!/usr/bin/env bash
# First-time install of the self-hosted zkward website on Bakchodi.
#
# Prereq: paper-trader-worker + cron-workers already installed
# (this shares the same /opt/zkward-worker checkout + .env).
#
#   sudo bash /opt/zkward-worker/services/zkward-web/install.sh
set -euo pipefail

INSTALL_DIR=/opt/zkward-worker
SYSTEMD_DIR=/etc/systemd/system
SERVICE_USER=zkward

log() { echo "[install-web] $*" >&2; }
fail() { echo "[install-web] ERROR: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "run with sudo"
[ -d "$INSTALL_DIR" ] || fail "$INSTALL_DIR not found — run services/paper-trader-worker/install.sh first"
[ -f "$INSTALL_DIR/.env" ] || fail "$INSTALL_DIR/.env not found"

log "1/4: production build (5-10 min, one-time)"
if [ ! -d "$INSTALL_DIR/.next" ]; then
  sudo -u "$SERVICE_USER" bash -c "cd $INSTALL_DIR && bun run build"
else
  log "  .next/ exists — assuming already built. Re-run 'sudo bash services/zkward-web/deploy.sh' to rebuild."
fi

log "2/4: install systemd unit"
install -m 644 "$INSTALL_DIR/services/zkward-web/zkward-web.service" "$SYSTEMD_DIR/"
systemctl daemon-reload

log "3/4: enable + start"
systemctl enable --now zkward-web.service
sleep 3

log "4/4: verify listening on :3000"
if ! curl -fsS http://localhost:3000/ >/dev/null 2>&1; then
  log "  WARN: :3000 not responding yet. Check:"
  log "    systemctl status zkward-web.service"
  log "    journalctl -u zkward-web.service -n 40 --no-pager"
else
  log "  OK — http://localhost:3000/ responded"
fi

log ""
log "done. site is now serving on localhost:3000."
log ""
log "NEXT STEP: configure Cloudflare tunnel to route zkward.com → localhost:3000"
log "See services/zkward-web/README.md § 'Cloudflare tunnel setup'"
