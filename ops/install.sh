#!/usr/bin/env bash
# Installs HTSDesk on a fresh Debian/Ubuntu host.
#
# Idempotent: safe to re-run after a code update. It does not touch
# /etc/htsdesk/*.env, so re-running never clobbers secrets.
set -euo pipefail

APP=/opt/htsdesk
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
USER_NAME=htsdesk

need_root() { [ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }; }
need_root

echo "==> user and directories"
id -u "$USER_NAME" >/dev/null 2>&1 || useradd --system --home "$APP" --shell /usr/sbin/nologin "$USER_NAME"
install -d -o "$USER_NAME" -g "$USER_NAME" -m 0750 "$APP" "$APP/data"
install -d -o "$USER_NAME" -g "$USER_NAME" -m 0750 /var/backups/htsdesk
install -d -o root -g root -m 0750 /etc/htsdesk

echo "==> application"
rsync -a --delete \
  --exclude 'data/' --exclude '.git/' --exclude 'web/node_modules/' \
  --exclude 'web/.next/' --exclude '.venv/' \
  "$SRC/" "$APP/"
chown -R "$USER_NAME:$USER_NAME" "$APP"

echo "==> python environment"
[ -d "$APP/.venv" ] || python3 -m venv "$APP/.venv"
"$APP/.venv/bin/pip" -q install --upgrade pip
"$APP/.venv/bin/pip" -q install fastapi uvicorn httpx pydantic

echo "==> web build"
sudo -u "$USER_NAME" bash -lc "cd '$APP/web' && npm ci --omit=dev=false && rm -rf .next && npm run build"

echo "==> secrets"
for f in api.env web.env; do
  if [ ! -f "/etc/htsdesk/$f" ]; then
    install -o root -g root -m 0600 /dev/null "/etc/htsdesk/$f"
    {
      echo "# generated $(date -u +%FT%TZ) — fill in the rest from .env.example"
      echo "HTSDESK_ADMIN_TOKEN=$(openssl rand -hex 32)"
      echo "HTSDESK_EMAIL_SECRET=$(openssl rand -hex 32)"
    } >> "/etc/htsdesk/$f"
    echo "    created /etc/htsdesk/$f with fresh secrets — add the provider keys"
  else
    echo "    /etc/htsdesk/$f exists, left alone"
  fi
done

echo "==> reference data"
if [ ! -f "$APP/data/htsdesk.db" ]; then
  sudo -u "$USER_NAME" bash -lc "cd '$APP' && .venv/bin/python ingest/refresh.py"
else
  echo "    present, skipping (run 'make refresh' to update)"
fi

echo "==> services"
install -m 0644 "$APP/deploy"/htsdesk-*.service "$APP/deploy"/htsdesk-*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now htsdesk-api htsdesk-web
systemctl enable --now htsdesk-ingest.timer htsdesk-diff.timer htsdesk-backup.timer

echo "==> preflight"
set -a; . /etc/htsdesk/web.env; set +a
sudo -u "$USER_NAME" -E "$APP/.venv/bin/python" "$APP/ops/preflight.py" || true

cat <<'NEXT'

Next, by hand:
  1. Fill /etc/htsdesk/api.env and web.env from .env.example
     (Stripe keys and price ids, a mail provider key, ANTHROPIC_API_KEY, SITE_URL)
  2. Point deploy/nginx.conf at your hostname, install it, and run certbot
  3. systemctl restart htsdesk-api htsdesk-web
  4. Re-run ops/preflight.py — it should report no failures
NEXT
