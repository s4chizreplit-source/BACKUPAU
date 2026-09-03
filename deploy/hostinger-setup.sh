#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════════════
# AutoCliper — one-shot VPS installer (Hostinger / any Ubuntu 22.04+ VPS)
#
# Run as root on a FRESH Ubuntu VPS:
#   bash <(curl -fsSL https://raw.githubusercontent.com/thedevlovable/autocliper/main/deploy/hostinger-setup.sh)
#
# What it does, in order:
#   1. Installs Node 20, pnpm, ffmpeg, yt-dlp, PostgreSQL, Caddy (auto-HTTPS)
#   2. Clones the repo to /opt/autocliper and builds UI + API
#   3. Creates the database + a system user, writes /etc/autocliper.env
#   4. Installs a systemd service (auto-restart, starts on boot)
#   5. Configures Caddy to serve your domain with automatic SSL
#
# Safe to re-run: existing env/database/config are kept, code is re-pulled.
# ══════════════════════════════════════════════════════════════════════════════
set -euo pipefail

[ "$(id -u)" = "0" ] || { echo "Run as root (login as root or use: sudo -i)"; exit 1; }

APP_DIR=/opt/autocliper
ENV_FILE=/etc/autocliper.env
DATA_DIR=/var/lib/autocliper
DEFAULT_GIT_URL="https://github.com/thedevlovable/autocliper.git"

echo ""
echo "══ AutoCliper VPS installer ══"
echo ""

# ── 1. Questions (only asked on first run) ────────────────────────────────────
if [ -f "$ENV_FILE" ]; then
  echo "→ $ENV_FILE already exists — keeping it (delete it to reconfigure)."
  DOMAIN=$(grep -oP '(?<=^PUBLIC_APP_URL=https://).*' "$ENV_FILE" || true)
else
  # Read answers from the real terminal, NOT stdin: under `curl | bash` stdin
  # is the script itself, so a plain `read` silently swallows script source
  # lines as "answers" and fills domain/keys with garbage.
  [ -r /dev/tty ] || { echo "No terminal available for questions — run via: bash <(curl -fsSL <script-url>)"; exit 1; }
  read -rp "Your domain (without https://, e.g. autocliper.com): " DOMAIN </dev/tty
  case "$DOMAIN" in
    ''|*[!a-zA-Z0-9.-]*) echo "'$DOMAIN' does not look like a valid domain."; exit 1;;
  esac
  read -rp "Git repo URL [default: $DEFAULT_GIT_URL]: " GIT_URL </dev/tty
  GIT_URL=${GIT_URL:-$DEFAULT_GIT_URL}
  read -rp "ZYLA_API_KEY: " ZYLA_API_KEY </dev/tty
  read -rp "DEEPGRAM_API_KEY: " DEEPGRAM_API_KEY </dev/tty
  read -rp "ZAPUPI_ZAP_KEY: " ZAPUPI_ZAP_KEY </dev/tty
  read -rp "POSTFORME_API_KEY (postforme.dev — for social auto-post): " POSTFORME_API_KEY </dev/tty
  read -rp "RESEND_API_KEY (optional, Enter to skip): " RESEND_API_KEY </dev/tty
  read -rp "ADMIN_EMAILS (optional, comma separated, Enter to skip): " ADMIN_EMAILS </dev/tty
fi
GIT_URL=${GIT_URL:-$DEFAULT_GIT_URL}

# ── 2. Base packages ──────────────────────────────────────────────────────────
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git ca-certificates gnupg ufw ffmpeg postgresql postgresql-contrib

# Node 20 (NodeSource)
if ! command -v node >/dev/null || [ "$(node -v | cut -c2-3)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
command -v pnpm >/dev/null || npm install -g pnpm

# yt-dlp (same binary the production build uses)
curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp
chmod +x /usr/local/bin/yt-dlp
echo "→ yt-dlp $(/usr/local/bin/yt-dlp --version)"

# Caddy (automatic HTTPS)
if ! command -v caddy >/dev/null; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
fi

# ── 3. System user + directories ──────────────────────────────────────────────
id -u autocliper >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin autocliper
mkdir -p "$DATA_DIR/clips"

# ── 4. Database (kept on re-runs) ─────────────────────────────────────────────
# On non-fresh VPSes (removed-but-not-purged installs) the postgresql.service
# unit can be missing even though apt considers the package installed — force
# a reinstall of the server packages so the unit files land on disk.
if ! systemctl list-unit-files 'postgresql*' 2>/dev/null | grep -q postgresql; then
  dpkg --configure -a || true
  PG_VER=$(apt-cache depends postgresql | sed -n 's/.*Depends: postgresql-\([0-9]\+\).*/\1/p' | head -1)
  apt-get install -y --reinstall postgresql-common "postgresql-${PG_VER:-16}" postgresql-contrib
fi
systemctl enable --now postgresql
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='autocliper'" | grep -q 1; then
  DB_PASS=$(openssl rand -hex 24)
  sudo -u postgres psql -c "CREATE ROLE autocliper LOGIN PASSWORD '$DB_PASS'"
  sudo -u postgres createdb -O autocliper autocliper
  NEW_DB=1
else
  echo "→ database role already exists — keeping it."
  NEW_DB=0
fi

# ── 5. Code: clone or update ──────────────────────────────────────────────────
if [ -d "$APP_DIR/.git" ]; then
  # Earlier runs chown the app dir to the service user; git run as root then
  # refuses to touch it ("dubious ownership") — mark it safe explicitly.
  git config --global --add safe.directory "$APP_DIR"
  git -C "$APP_DIR" pull --ff-only
else
  git clone "$GIT_URL" "$APP_DIR"
fi

# ── 6. Environment file (created once) ────────────────────────────────────────
if [ ! -f "$ENV_FILE" ]; then
  if [ "$NEW_DB" != "1" ]; then
    # DB exists but the env file was deleted (reconfigure) — rotate the role
    # password so the fresh env file and the database agree on credentials.
    DB_PASS=$(openssl rand -hex 24)
    sudo -u postgres psql -c "ALTER ROLE autocliper PASSWORD '$DB_PASS'" >/dev/null
    echo "→ database kept; role password rotated for the fresh config."
  fi
  # Cap clip storage at 60% of the data disk (min 20 GB) so the OS and
  # database never get squeezed out on small VPS plans.
  DISK_GB=$(df -BG --output=avail "$DATA_DIR" | tail -1 | tr -dc '0-9')
  CAP_GB=$(( DISK_GB * 60 / 100 )); [ "$CAP_GB" -ge 20 ] || CAP_GB=20
  cat > "$ENV_FILE" <<EOF
NODE_ENV=production
PORT=3000
PUBLIC_APP_URL=https://$DOMAIN
DATABASE_URL=postgresql://autocliper:$DB_PASS@127.0.0.1:5432/autocliper
CLIPS_DIR=$DATA_DIR/clips
SESSION_SECRET=$(openssl rand -hex 32)
ZYLA_API_KEY=$ZYLA_API_KEY
DEEPGRAM_API_KEY=$DEEPGRAM_API_KEY
ZAPUPI_ZAP_KEY=$ZAPUPI_ZAP_KEY
POSTFORME_API_KEY=$POSTFORME_API_KEY
STORAGE_SIZE_CAP_GB=$CAP_GB
EOF
  [ -n "${RESEND_API_KEY:-}" ] && echo "RESEND_API_KEY=$RESEND_API_KEY" >> "$ENV_FILE"
  [ -n "${ADMIN_EMAILS:-}" ] && echo "ADMIN_EMAILS=$ADMIN_EMAILS" >> "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "→ wrote $ENV_FILE"
fi

# ── 7. Build ──────────────────────────────────────────────────────────────────
cd "$APP_DIR"
pnpm install --frozen-lockfile || pnpm install
pnpm --filter @workspace/ytdlp-ui run build
pnpm --filter @workspace/api-server run build
chown -R autocliper:autocliper "$APP_DIR" "$DATA_DIR"

# ── 8. systemd service ────────────────────────────────────────────────────────
# Node heap scales with the machine: RAM/4, clamped 1024..6144 MB (KVM4 -> 4096).
HEAP_MB=$(awk '/MemTotal/ {mb=int($2/1024/4); if (mb<1024) mb=1024; if (mb>6144) mb=6144; print mb}' /proc/meminfo)
cat > /etc/systemd/system/autocliper.service <<EOF
[Unit]
Description=AutoCliper (API + UI)
After=network.target postgresql.service
Wants=postgresql.service

[Service]
User=autocliper
WorkingDirectory=$APP_DIR/artifacts/api-server
EnvironmentFile=$ENV_FILE
# --max-old-space-size: let Node GC aggressively before the Linux OOM killer
# fires. Without this Node grows unbounded until the kernel sends SIGKILL,
# which Caddy sees as a 502 for every user until systemd restarts the process.
ExecStart=$(command -v node) --enable-source-maps --max-old-space-size=$HEAP_MB dist/index.mjs
Restart=always
RestartSec=2
# Give the server up to 30 s to drain in-flight requests on SIGTERM.
TimeoutStopSec=30
KillSignal=SIGTERM
LimitNOFILE=65535
# Lower OOM score: kernel will prefer to kill other processes before Node.
OOMScoreAdjust=-500

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now autocliper
systemctl restart autocliper

# ── 9. Caddy (automatic HTTPS) ────────────────────────────────────────────────
if [ -n "${DOMAIN:-}" ]; then
  cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN, www.$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:3000
}
EOF
  systemctl enable --now caddy
  systemctl reload caddy || systemctl restart caddy
fi

# ── 10. Firewall (best effort) ────────────────────────────────────────────────
if command -v ufw >/dev/null; then
  ufw allow 22/tcp >/dev/null 2>&1 || true
  ufw allow 80/tcp >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
fi

echo ""
echo "══════════════════════════════════════════════════════════════"
echo "✅ DONE. Final steps:"
echo ""
echo "1. Point your domain to this server (DNS):"
echo "     A record:  @    → $(curl -fsS -4 ifconfig.me 2>/dev/null || echo '<this VPS IP>')"
echo "     A record:  www  → same IP"
echo "   SSL activates automatically a few minutes after DNS points here."
echo ""
echo "2. Check the app:   curl -s http://127.0.0.1:3000/api/healthz"
echo "   Live logs:       journalctl -u autocliper -f"
echo "   Restart:         systemctl restart autocliper"
echo "   Update later:    bash $APP_DIR/deploy/update.sh"
echo "══════════════════════════════════════════════════════════════"
