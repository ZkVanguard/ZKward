#!/usr/bin/env bash
# ZKward paper-trader worker — idempotent installer for Bakchodi (or
# any modern Linux with systemd + bun). Run as root or with sudo.
#
#   curl -fsSL https://raw.githubusercontent.com/ZkVanguard/ZkWard/main/services/paper-trader-worker/install.sh | sudo bash
#
# Or checkout the repo first and run:
#
#   sudo bash services/paper-trader-worker/install.sh
#
# What it does:
#   1. Creates zkward system user (idempotent)
#   2. Ensures /opt/zkward-worker exists
#   3. Clones or pulls the repo into /opt/zkward-worker
#   4. Ensures bun is installed at /usr/local/bin/bun
#   5. Runs `bun install` for deps
#   6. Copies systemd unit + timer files
#   7. Prompts you to create /opt/zkward-worker/.env with DATABASE_URL
#      + any other trader-required env vars
#   8. Enables + starts the timer
#
# After running, `systemctl status paper-trader-worker.timer` should
# show "active (waiting)" and `journalctl -u paper-trader-worker.service
# -f` should show tick logs every 5 min.
set -euo pipefail

INSTALL_DIR=/opt/zkward-worker
REPO_URL=https://github.com/ZkVanguard/ZKward.git
SYSTEMD_DIR=/etc/systemd/system
SERVICE_USER=zkward

log() { echo "[install] $*" >&2; }
fail() { echo "[install] ERROR: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "run with sudo (installs systemd unit)"

log "1/8: ensuring $SERVICE_USER user exists"
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$INSTALL_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
fi

log "2/8: ensuring $INSTALL_DIR exists"
mkdir -p "$INSTALL_DIR"

log "3/8: clone/pull repo into $INSTALL_DIR"
if [ -d "$INSTALL_DIR/.git" ]; then
  git -C "$INSTALL_DIR" fetch --depth=1 origin main
  git -C "$INSTALL_DIR" reset --hard origin/main
else
  git clone --depth=1 "$REPO_URL" "$INSTALL_DIR"
fi

log "4/8: ensuring bun is installed"
if ! command -v bun >/dev/null 2>&1; then
  log "installing bun to /usr/local/bin"
  curl -fsSL https://bun.sh/install | bash
  # Move the user-scope install to system-wide so systemd can find it.
  BUN_USER="${HOME:-/root}/.bun/bin/bun"
  if [ -x "$BUN_USER" ]; then
    install -m 755 "$BUN_USER" /usr/local/bin/bun
  else
    fail "bun install did not produce a binary; check curl output"
  fi
fi
log "    bun version: $(bun --version)"

log "5/8: installing repo dependencies (this can take 2-5 min first time)"
cd "$INSTALL_DIR"
sudo -u "$SERVICE_USER" bash -c "cd $INSTALL_DIR && bun install --frozen-lockfile" || \
  sudo -u "$SERVICE_USER" bash -c "cd $INSTALL_DIR && bun install"

log "6/8: copying systemd unit files"
install -m 644 "$INSTALL_DIR/services/paper-trader-worker/paper-trader-worker.service" "$SYSTEMD_DIR/"
install -m 644 "$INSTALL_DIR/services/paper-trader-worker/paper-trader-worker.timer" "$SYSTEMD_DIR/"
systemctl daemon-reload

log "7/8: checking .env"
if [ ! -f "$INSTALL_DIR/.env" ]; then
  cat >&2 <<EOF

[install] ── STOP ────────────────────────────────────────────────
[install] $INSTALL_DIR/.env does not exist. Create it with at least:
[install]
[install]     DATABASE_URL=postgresql://user:pass@localhost:6432/bakchodi?sslmode=disable
[install]
[install] Add any other env the trader needs (aggregator API keys,
[install] BLUEFIN_* if BluefinService is imported transitively, etc).
[install] Match what was set in Vercel prod for zkvanguard.
[install]
[install] Then re-run this installer OR just:
[install]     sudo systemctl enable --now paper-trader-worker.timer
[install]
[install] ──────────────────────────────────────────────────────────
EOF
  exit 0
fi
chown "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR/.env"
chmod 600 "$INSTALL_DIR/.env"

log "8/8: enabling + starting timer"
systemctl enable --now paper-trader-worker.timer

log "done."
log ""
log "verify with:"
log "  systemctl status paper-trader-worker.timer"
log "  journalctl -u paper-trader-worker.service -f"
log ""
log "first tick fires 1 min after enable; then every 5 min."
