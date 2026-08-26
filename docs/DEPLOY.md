# Deploying HTSDesk

Two processes: a Python API that owns the data, and a Next.js app that renders
it. The reference data is a SQLite file built from public sources, so there is
no database to provision.

## What you need to buy

| Thing | Suggested | Cost |
|---|---|---|
| VPS for the API | Hetzner CX22 | ~$5/mo |
| Web hosting | Vercel free tier | $0 |
| Domain | short and brandable | ~$12/yr |
| Anthropic API key | for the reasoning layer | usage-based |

Total to start: about $5/month plus API usage.

An exact-match domain (`ushtscodes.com` and the like) is a liability now — it
reads as thin-affiliate to Google. Pick a name you can build a brand on.

## API (the VPS)

```bash
adduser --system --group htsdesk
git clone <repo> /opt/htsdesk && cd /opt/htsdesk
python3 -m venv .venv
.venv/bin/pip install fastapi uvicorn httpx pydantic
apt-get install -y poppler-utils          # pdftotext, for the Chapter 99 Notes

.venv/bin/python ingest/refresh.py        # HTS + Notes + Federal Register
.venv/bin/python ingest/cross.py          # 200k ruling metadata, ~15 min
.venv/bin/python ingest/cross.py --skip-metadata --bodies 60000   # full text

mkdir -p /etc/htsdesk
printf 'ANTHROPIC_API_KEY=sk-ant-...\n' > /etc/htsdesk/api.env
chmod 600 /etc/htsdesk/api.env

cp deploy/htsdesk-api.service /etc/systemd/system/
cp deploy/htsdesk-ingest.{service,timer} /etc/systemd/system/
systemctl enable --now htsdesk-api htsdesk-ingest.timer
```

Put nginx in front using `deploy/nginx.conf` (edit the hostname), then issue a
certificate with certbot.

## Web (Vercel)

Set the project root to `web/`, then set:

```
HTSDESK_API=https://api.yourdomain.com
NEXT_PUBLIC_HTSDESK_API=https://api.yourdomain.com
SITE_URL=https://yourdomain.com
```

`HTSDESK_ORIGINS` on the API must list the web origin, or the catalogue
audit will fail CORS in the browser.

## Keeping data current

`htsdesk-ingest.timer` runs `ingest/refresh.py` daily: it re-downloads the
HTS schedule and the Chapter 99 PDF, re-extracts the U.S. Notes scope, rebuilds
the database and polls the Federal Register.

Ruling ingest is separate and incremental — the corpus only grows at the
margin, so run `ingest/cross.py` weekly rather than daily.

**Re-verify the user-fee constants every October.** MPF's floor and cap are
inflation-adjusted each fiscal year under 19 CFR 24.22(k); they are declared as
dated constants in `core/duty.py` for exactly this reason.
