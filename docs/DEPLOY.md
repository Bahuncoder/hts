# Deploying HTSDesk

Two independent deployments: a Python API on a VPS that owns the reference
data and runs the engine, and a Next.js app on Vercel that renders it. The
reference data is a SQLite file built from public sources, so there is no
database to provision for it — but Vercel's serverless functions have no
persistent local disk, so the *account* data (signups, catalogues, alerts)
lives in Turso, a managed libSQL database, rather than a file
on either host.

## What you need to buy

| Thing | Suggested | Cost |
|---|---|---|
| VPS for the API | Hetzner CX22 | ~$5/mo |
| Web hosting | Vercel Pro (the free Hobby plan is non-commercial; check current terms) | ~$20/mo |
| Accounts database | Turso free tier | $0 to start |
| Domain | short and brandable | ~$12/yr |
| Anthropic API key | for the reasoning layer | usage-based |

Total to start: about $25/month plus API usage.

An exact-match domain (`ushtscodes.com` and the like) is a liability now — it
reads as thin-affiliate to Google. Pick a name you can build a brand on.

## API (the VPS)

```bash
adduser --system --group htsdesk
git clone <repo> /opt/htsdesk && cd /opt/htsdesk
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt   # pinned; never an unpinned pip install
apt-get install -y poppler-utils python3-pil   # pdftotext/pdftoppm and Pillow: Chapter 99 notes and their expired-row shading

.venv/bin/python ingest/refresh.py        # HTS + Notes + Federal Register
.venv/bin/python ingest/cross.py          # 200k ruling metadata, ~15 min
.venv/bin/python ingest/cross.py --skip-metadata --bodies 60000   # full text

mkdir -p /etc/htsdesk
printf 'ANTHROPIC_API_KEY=sk-ant-...\nHTSDESK_ADMIN_TOKEN=...\nHTSDESK_WEB_URL=https://yourdomain.com\n' > /etc/htsdesk/api.env
chmod 600 /etc/htsdesk/api.env

cp deploy/htsdesk-api.service /etc/systemd/system/
cp deploy/htsdesk-ingest.{service,timer} deploy/htsdesk-diff.{service,timer} /etc/systemd/system/
systemctl enable --now htsdesk-api htsdesk-ingest.timer htsdesk-diff.timer
```

Put nginx in front using `deploy/nginx.conf` (edit the hostname), then issue a
certificate with certbot.

`ops/install.sh` does all of the above (and generates `HTSDESK_ADMIN_TOKEN`
for you); use it on a fresh host instead of the manual steps if that's easier.

## Web (Vercel)

The web app has no local disk of its own on Vercel, so account data (signups,
catalogues, watched codes, alerts) is stored in Turso rather
than a file. Create a Turso database (`turso db create htsdesk`) and set the
project root to `web/`, then set:

```
HTSDESK_API=https://api.yourdomain.com
HTSDESK_API_KEY=<a key from HTSDESK_API_KEYS on the API>
TURSO_DATABASE_URL=libsql://htsdesk-<org>.turso.io
TURSO_AUTH_TOKEN=<turso db tokens create htsdesk>
SITE_URL=https://yourdomain.com
```

plus the email-provider, `HTSDESK_EMAIL_SECRET` and
`HTSDESK_SIGNING_SECRET` values from `.env.example`. The signing secret makes
saved catalogues server-produced (the audit proxy signs each result and saving
verifies it), so it must be **identical on every instance or Vercel
deployment** that serves the web app; without any secret, audits still run but
saving reports that it is unavailable. `web/src/lib/store.ts` creates the schema itself on first
connection — nothing to migrate by hand.

Set `HTSDESK_BEHIND_PROXY=1` on Vercel. Every per-caller budget (audit
requests, items per day, classification searches, sign-in throttling) is keyed
on the client address; without it all visitors share one address, so one heavy
user exhausts the allowance for everybody.

`HTSDESK_ORIGINS` on the API does **not** need the web origin: the browser
never calls the API directly, only the Next.js server does, server-side.
Leave it empty unless a third party genuinely needs browser access.

Locally, leaving `TURSO_DATABASE_URL` unset falls back to an embedded libSQL
file at `../data/accounts.db` — the same zero-setup behavior as before, no
Turso account needed for development.

## Keeping data current

`htsdesk-ingest.timer` runs `ingest/refresh.py` daily: it downloads the HTS
schedule and the Chapter 99 PDF into a new immutable `data/releases/<utc>/`
directory, re-extracts the U.S. Notes scope, rebuilds the database in one
validated transaction (a truncated or reshaped download is rejected and the
previous data keeps serving), and polls the Federal Register. The API reloads
its engine when the dataset revision changes; see `docs/RUNBOOK.md`.

Ruling ingest is separate and incremental — the corpus only grows at the
margin, so run `ingest/cross.py` weekly rather than daily.

**Re-verify the user-fee constants every October.** MPF's floor and cap are
inflation-adjusted each fiscal year under 19 CFR 24.22(k); they are declared as
dated constants in `core/duty.py` for exactly this reason.

## Backing up account data

Turso's platform is the backup story in production — enable its scheduled
backups on the database dashboard, or take a manual snapshot with
`turso db shell htsdesk .dump > accounts.sql`. `ops/backup-accounts.py` and
`ops/restore-accounts.py` still work, but only against the local embedded-file
fallback (`TURSO_DATABASE_URL` unset) — they operate on a SQLite file
directly and have no visibility into a remote Turso database.
