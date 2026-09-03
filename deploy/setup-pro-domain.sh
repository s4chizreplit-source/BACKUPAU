#!/usr/bin/env bash
# AutoCliper — one-shot VPS configuration helper
#
#   Run on the VPS as root:
#     cd /opt/autocliper && git pull && bash deploy/setup-pro-domain.sh
#
# What it does:
#   1. Updates Caddyfile to autocliper.pro (fixes SSL + routing)
#   2. Adds/updates required env vars in /etc/autocliper.env
#   3. Pulls latest code + rebuilds + restarts via update.sh
set -euo pipefail

ENV_FILE=/etc/autocliper.env
CADDY_FILE=/etc/caddy/Caddyfile
APP_DIR=/opt/autocliper
DOMAIN=autocliper.pro

echo ""
echo "══════════════════════════════════════════════════════════"
echo "  AutoCliper — VPS setup for $DOMAIN"
echo "══════════════════════════════════════════════════════════"
echo ""

# ── 1. Caddyfile ──────────────────────────────────────────────────────────────
echo "[ 1/4 ] Updating Caddyfile → $DOMAIN"
cat > "$CADDY_FILE" <<EOF
$DOMAIN, www.$DOMAIN {
  encode gzip
  reverse_proxy 127.0.0.1:3000
}
EOF
systemctl reload caddy 2>/dev/null || systemctl restart caddy 2>/dev/null || true
echo "       ✓ Caddyfile updated + caddy reloaded"

# ── 2. Env vars ───────────────────────────────────────────────────────────────
echo ""
echo "[ 2/4 ] Updating /etc/autocliper.env"

# Helper: set or update a key in the env file
upsert_env() {
  local key="$1" value="$2"
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
    echo "       ✓ updated  ${key}"
  else
    echo "${key}=${value}" >> "$ENV_FILE"
    echo "       ✓ added    ${key}"
  fi
}

# Always set these (safe to overwrite)
upsert_env "APP_BASE_URL"    "https://$DOMAIN"
upsert_env "PUBLIC_APP_URL"  "https://$DOMAIN"
upsert_env "ALLOWED_ORIGIN"  "https://$DOMAIN"

# WHOP_API_KEY — prompt only if not already set
if grep -q "^WHOP_API_KEY=" "$ENV_FILE" 2>/dev/null && \
   [ "$(grep "^WHOP_API_KEY=" "$ENV_FILE" | cut -d= -f2-)" != "" ]; then
  echo "       ✓ kept     WHOP_API_KEY (already set)"
else
  echo ""
  echo "  → Whop dashboard: https://whop.com/dashboard/settings/api-keys/"
  read -rp "  WHOP_API_KEY: " WHOP_API_KEY </dev/tty
  upsert_env "WHOP_API_KEY" "$WHOP_API_KEY"
fi

# WHOP_WEBHOOK_SECRET — prompt only if not already set
if grep -q "^WHOP_WEBHOOK_SECRET=" "$ENV_FILE" 2>/dev/null && \
   [ "$(grep "^WHOP_WEBHOOK_SECRET=" "$ENV_FILE" | cut -d= -f2-)" != "" ]; then
  echo "       ✓ kept     WHOP_WEBHOOK_SECRET (already set)"
else
  echo ""
  echo "  → Whop dashboard: https://whop.com/dashboard/developer/webhooks/"
  echo "    Endpoint URL:   https://$DOMAIN/api/pay/whop/webhook"
  echo "    Event:          payment.succeeded"
  echo "    (Create the webhook, then paste the Signing Secret below)"
  read -rp "  WHOP_WEBHOOK_SECRET: " WHOP_WEBHOOK_SECRET </dev/tty
  upsert_env "WHOP_WEBHOOK_SECRET" "$WHOP_WEBHOOK_SECRET"
fi

echo ""
echo "       ✓ /etc/autocliper.env ready"

# ── 3. Pull + build + restart ─────────────────────────────────────────────────
echo ""
echo "[ 3/4 ] Pulling latest code + rebuilding"
bash "$APP_DIR/deploy/update.sh"

# ── 4. Final checks ───────────────────────────────────────────────────────────
echo ""
echo "[ 4/4 ] Final checks"
echo ""
echo "  Caddy status:  $(systemctl is-active caddy)"
echo "  App status:    $(systemctl is-active autocliper)"
echo ""
echo "  Healthcheck:   $(curl -sf --max-time 5 http://127.0.0.1:3000/api/healthz || echo 'FAILED — check logs with: journalctl -u autocliper -n 30')"
echo ""
echo "══════════════════════════════════════════════════════════"
echo "  ✅ Done!  Visit https://$DOMAIN to confirm."
echo ""
echo "  If SSL isn't ready yet — wait 1–2 min then:"
echo "    curl -I https://$DOMAIN/api/healthz"
echo "══════════════════════════════════════════════════════════"
echo ""
