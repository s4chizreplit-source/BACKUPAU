#!/usr/bin/env bash
# AutoCliper — update the VPS to the latest code from GitHub, then restart.
#   bash /opt/autocliper/deploy/update.sh
set -euo pipefail

# Whole script lives inside main() so `git pull` replacing this file mid-run
# can never corrupt what bash is executing.
main() {
  APP_DIR=/opt/autocliper
  cd "$APP_DIR"
  git pull --ff-only

  # Install + build at the LOWEST CPU/IO priority: a full-speed build starves
  # the live node/Caddy processes on a small VPS and users see timeouts during
  # every deploy. nice/ionice keep the site serving while the update compiles.
  lowprio() {
    if command -v ionice >/dev/null 2>&1; then nice -n 19 ionice -c 3 "$@"; else nice -n 19 "$@"; fi
  }
  lowprio pnpm install --frozen-lockfile || lowprio pnpm install
  lowprio pnpm --filter @workspace/ytdlp-ui run build
  lowprio pnpm --filter @workspace/api-server run build
  chown -R autocliper:autocliper "$APP_DIR"

  # Keep the systemd unit in sync with the repo — ensures Node flags,
  # OOM score, and restart config are always up-to-date after a pull.
  if [ -f /etc/systemd/system/autocliper.service ]; then
    NODE_BIN=$(command -v node)
    # Node heap scales with the machine: RAM/4, clamped 1024..6144 MB
    # (KVM4 16 GB -> 4096). Buffers/ffmpeg live outside the heap, so /4 is safe.
    HEAP_MB=$(awk '/MemTotal/ {mb=int($2/1024/4); if (mb<1024) mb=1024; if (mb>6144) mb=6144; print mb}' /proc/meminfo)
    cat > /etc/systemd/system/autocliper.service <<SVCEOF
[Unit]
Description=AutoCliper (API + UI)
After=network.target postgresql.service
Wants=postgresql.service

[Service]
User=autocliper
WorkingDirectory=$APP_DIR/artifacts/api-server
EnvironmentFile=/etc/autocliper.env
ExecStart=$NODE_BIN --enable-source-maps --max-old-space-size=$HEAP_MB dist/index.mjs
Restart=always
RestartSec=2
TimeoutStopSec=30
KillSignal=SIGTERM
LimitNOFILE=65535
OOMScoreAdjust=-500

[Install]
WantedBy=multi-user.target
SVCEOF
    systemctl daemon-reload
    echo "→ systemd unit updated"
  fi

  systemctl restart autocliper
  systemctl --no-pager --lines=5 status autocliper || true
  echo ""

  # Node boots + self-heals the DB schema on start — poll up to 60s instead of
  # a single 2s check (which false-alarmed "NOT RESPONDING" on healthy deploys).
  echo -n "⏳ Waiting for the app to come up"
  for _ in $(seq 1 30); do
    if HEALTH=$(curl -sf --max-time 3 http://127.0.0.1:3000/api/healthz 2>/dev/null); then
      echo ""
      echo "✅ Updated. Health: $HEALTH"
      return 0
    fi
    echo -n "."
    sleep 2
  done

  echo ""
  echo "❌ App did not respond within 60s. Recent logs:"
  journalctl -u autocliper --no-pager -n 30 || true
  return 1
}

main "$@"
