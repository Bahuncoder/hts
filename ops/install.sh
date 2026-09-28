#!/usr/bin/env bash
# Installs the HTSDesk API on a fresh Debian/Ubuntu host.
#
# The web app is not built or run here: it deploys separately to Vercel and
# has no persistent local state of its own (accounts live in Turso). This
# host runs the engine, the reference-data ingest, and the daily change-diff
# trigger only.
#
# Idempotent: safe to re-run after a code update. It does not touch
# /etc/htsdesk/*.env, so re-running never clobbers secrets.
set -euo pipefail

APP=/opt/htsdesk
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
USER_NAME=htsdesk

need_root() { [ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }; }
need_root

REQUIRE_READY=0
[ "${1:-}" = "--require-ready" ] && REQUIRE_READY=1

echo "==> prerequisites"
MISSING=""
for cmd in python3 rsync openssl pdftotext; do
  command -v "$cmd" >/dev/null 2>&1 || MISSING="$MISSING $cmd"
done
# Debian/Ubuntu ship the venv module as the separate python3-venv package;
# a minimal image can have python3 without it, which this loop's `command -v`
# check cannot see (venv is a Python module, not its own binary). Caught here,
# not at the "python3 -m venv" step 20 lines down, where it would still fail
# safely (set -e) but with a raw Python traceback instead of this script's own
# prerequisite message and remediation command.
python3 -c "import venv" >/dev/null 2>&1 || MISSING="$MISSING python3-venv"
if [ -n "$MISSING" ]; then
  echo "missing:$MISSING" >&2
  echo "on Debian/Ubuntu: apt-get install -y python3-venv rsync openssl poppler-utils" >&2
  exit 1
fi

echo "==> user and directories"
id -u "$USER_NAME" >/dev/null 2>&1 || useradd --system --home "$APP" --shell /usr/sbin/nologin "$USER_NAME"
install -d -o "$USER_NAME" -g "$USER_NAME" -m 0750 "$APP" "$APP/data"
install -d -o root -g root -m 0750 /etc/htsdesk

echo "==> application"
rsync -a --delete \
  --exclude 'data/' --exclude '.git/' --exclude 'web/' --exclude '.venv/' \
  "$SRC/" "$APP/"
chown -R "$USER_NAME:$USER_NAME" "$APP"

echo "==> python environment"
[ -d "$APP/.venv" ] || python3 -m venv "$APP/.venv"
"$APP/.venv/bin/pip" -q install --upgrade pip
"$APP/.venv/bin/pip" -q install -r "$APP/requirements.txt"

echo "==> secrets"
if [ ! -f "/etc/htsdesk/api.env" ]; then
  install -o root -g root -m 0600 /dev/null "/etc/htsdesk/api.env"
  {
    echo "# generated $(date -u +%FT%TZ) — fill in the rest from .env.example"
    echo "HTSDESK_ADMIN_TOKEN=$(openssl rand -hex 32)"
  } >> "/etc/htsdesk/api.env"
  echo "    created /etc/htsdesk/api.env with fresh secrets — add the provider keys"
else
  echo "    /etc/htsdesk/api.env exists, left alone"
fi

echo "==> reference data"
if [ ! -f "$APP/data/htsdesk.db" ]; then
  sudo -u "$USER_NAME" bash -lc "cd '$APP' && .venv/bin/python ingest/refresh.py"
else
  echo "    present, skipping (run 'make refresh' to update)"
fi

echo "==> services"
install -m 0644 "$APP/deploy"/htsdesk-*.service "$APP/deploy"/htsdesk-*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now htsdesk-api
systemctl enable --now htsdesk-ingest.timer htsdesk-diff.timer

echo "==> readiness"
# Installation and readiness are different questions. A fresh host has no
# provider keys yet, so preflight is expected to fail the first time; report it
# plainly instead of hiding it, and let --require-ready make it fatal.
set -a; . /etc/htsdesk/api.env; set +a
if sudo -u "$USER_NAME" -E "$APP/.venv/bin/python" "$APP/ops/preflight.py"; then
  READY=1
else
  READY=0
  echo
  echo "NOT READY: installed, but preflight reported failures (above)."
fi

cat <<'NEXT'

Next, by hand:
  1. Fill /etc/htsdesk/api.env from .env.example
     (HTSDESK_API_KEYS for the web app to call in as, ANTHROPIC_API_KEY,
     HTSDESK_WEB_URL — the Vercel deployment's origin, for the diff trigger)
  2. Point deploy/nginx.conf at your hostname, install it, and run certbot
  3. systemctl restart htsdesk-api
  4. Re-run ops/preflight.py — it should report no failures
  5. Deploy web/ to Vercel separately (see docs/DEPLOY.md) with
     TURSO_DATABASE_URL and TURSO_AUTH_TOKEN set
NEXT

[ "$REQUIRE_READY" -eq 1 ] && [ "$READY" -ne 1 ] && exit 1
exit 0
