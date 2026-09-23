#!/usr/bin/env bash
# Deploy new website code to Bakchodi. Idempotent, safe to re-run.
#
# What it does:
#   1. git fetch + reset to origin/main
#   2. bun install (only if package.json or bun.lock changed)
#   3. bun run build (production Next.js build)
#   4. sudo systemctl reload-or-restart zkward-web.service
#
# Systemd graceful restart drains in-flight requests via SIGTERM.
# Typical downtime: <5 seconds while the new server binds :3000.
#
# Run as root or with sudo (systemctl needs privilege).
#
# Usage:
#   sudo bash services/zkward-web/deploy.sh
set -euo pipefail

INSTALL_DIR=/opt/zkward-worker
SERVICE_USER=zkward

log() { echo "[deploy] $*" >&2; }
fail() { echo "[deploy] ERROR: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "run with sudo"
[ -d "$INSTALL_DIR/.git" ] || fail "$INSTALL_DIR not a git repo — run install.sh first"

cd "$INSTALL_DIR"

log "1/4: git fetch + reset"
sudo -u "$SERVICE_USER" git fetch --depth=1 origin main
OLD_HEAD=$(git rev-parse HEAD)
sudo -u "$SERVICE_USER" git reset --hard origin/main
NEW_HEAD=$(git rev-parse HEAD)

if [ "$OLD_HEAD" = "$NEW_HEAD" ]; then
  log "already at $NEW_HEAD — nothing to deploy. skipping build."
  # Still restart in case env changed:
  systemctl restart zkward-web.service
  log "restarted zkward-web.service anyway (in case .env changed)"
  exit 0
fi

log "    $OLD_HEAD → $NEW_HEAD"

# Check if package.json or bun.lock changed → run bun install
DEPS_CHANGED=$(git diff --name-only "$OLD_HEAD" "$NEW_HEAD" | grep -E "^(package\.json|bun\.lock)$" || true)
if [ -n "$DEPS_CHANGED" ]; then
  log "2/4: deps changed — bun install"
  sudo -u "$SERVICE_USER" bash -c "cd $INSTALL_DIR && bun install --frozen-lockfile" || \
    sudo -u "$SERVICE_USER" bash -c "cd $INSTALL_DIR && bun install"
else
  log "2/4: deps unchanged — skipping bun install"
fi

log "3/4: bun run build (5-10 min)"
sudo -u "$SERVICE_USER" bash -c "cd $INSTALL_DIR && bun run build"

log "4/4: reload zkward-web.service"
systemctl restart zkward-web.service
sleep 3
systemctl is-active zkward-web.service >/dev/null || fail "service did not come back up — check journalctl -u zkward-web.service -n 40"

log "done. deployed $NEW_HEAD"
log ""
log "verify:"
log "  curl -sS http://localhost:3000/ | head -c 200"
log "  systemctl status zkward-web.service"
