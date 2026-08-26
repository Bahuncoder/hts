# Runbook

Day-to-day operation. For architecture see `README.md`; for the audit findings
see `SECURITY.md`.

## Local development

Two processes. The API owns the data and the engine; the web app renders and
proxies.

```bash
make api                                    # :8099
HTSDESK_API=http://127.0.0.1:8099 make web   # :3000
```

The web app talks to the API server-side only. Browsers never call the API
directly, so no CORS configuration is needed locally.

To exercise the paid limits and the audit proxy:

```bash
HTSDESK_API_KEYS=devkey make api
HTSDESK_API_KEY=devkey HTSDESK_API=http://127.0.0.1:8099 make web
```

## Before every deploy

```bash
make check
```

Runs the web build, 25 duty unit tests, 16 API security regressions and the
classifier evaluation. The API must be running for the API tests; they will
say so if it is not.

Do not deploy on a duty-test failure. Those tests encode what the engine must
refuse to charge — an unscoped trade remedy, a suspended heading, a tariff the
Supreme Court struck down — and a regression there overstates what a customer
owes.

## Data refresh

| Source | Cadence | Command | Why |
|---|---|---|---|
| HTS schedule | on revision | `make refresh` | new codes, changed rates |
| Chapter 99 notes | with HTS | `make refresh` | product scope for remedies |
| Federal Register | daily | `make fedreg` | rate changes, new actions |
| CROSS bodies | continuous | `make rulings` | classifier accuracy |
| Watched-code diff | daily, 09:30 UTC | `make diff` | alerts customers to changes |

`deploy/htsdesk-ingest.timer` runs the daily refresh at 09:00 UTC, ahead of
the US business day.

`make rulings` is resumable and idempotent — it fetches only rulings whose body
is still missing, newest first. Stopping it loses nothing; progress is
committed in batches of 500.

### Ingest writes and the write lock

SQLite takes a single writer. The body ingest and the Federal Register poller
both write, and running them together produces `database is locked`. Run them
one at a time. The API is unaffected: it opens read-only and WAL lets readers
proceed during writes.

## The change diff

The diff is what makes a subscription worth renewing: it matches tariff actions
published in the Federal Register against the codes each customer watches, and
records an alert when one lands.

```bash
make diff                      # needs HTSDESK_ADMIN_TOKEN in the environment
```

`deploy/htsdesk-diff.timer` runs it at 09:30 UTC, half an hour after the data
refresh, so it reads that morning's documents rather than yesterday's.

Matching is by code prefix, and the direction matters: an action naming
`2804.61` reaches a watched `2804.61.00.00`, so the mention is the prefix and
the watched code is the longer string. Reversing that silently misses every
heading-level action, which is most of them. Mentions shorter than six digits
are ignored as too loose to alert on.

Re-running is safe. Alerts are unique per account, document and code, so a
second pass over the same window creates nothing. `diff_state` records how far
the last run read; pass `?since=YYYY-MM-DD` to reconsider an earlier window.

## Alert emails

The diff run sends one digest per account covering everything not yet emailed —
a digest rather than a message per alert, because one action commonly names
several of a customer's codes and sending it once per code reads as spam.

```bash
make email-preview ACCOUNT=<account id>   # exactly what would be sent
```

Set one provider key, `RESEND_API_KEY` or `POSTMARK_API_KEY`. **With neither,
digests are still generated and recorded in `email_log` as `skipped`** — so the
path is exercised and inspectable before a key exists, rather than being code
that has never run. Check what happened with:

```sql
SELECT status, count(*) FROM email_log GROUP BY status;
```

Two rules worth knowing:

- **Email is a paid feature; alerts are not.** A free account sees every alert
  in the app and receives no mail. Losing the email does not lose the fact.
- **Every considered alert is stamped, whatever the outcome** — skipped for
  plan, opted out, or genuinely sent. An unstamped alert is reconsidered on
  every later run and would arrive as a backlog the moment the account upgrades
  or opts back in. Greeting a new subscriber with months of history is the
  wrong first impression.

Unsubscribe links are signed with `HTSDESK_EMAIL_SECRET` and work without a
session — someone who no longer wants our mail should not have to sign in to
stop it. Turning emails off leaves watched codes and in-app alerts untouched.

## Deploying

```
/opt/htsdesk            application, owned by the htsdesk user
/opt/htsdesk/data       reference DB — the only writable path
/etc/htsdesk/api.env    credentials, root-owned, mode 0600
/opt/htsdesk/data/accounts.db  accounts, catalogues, alerts — BACK THIS UP
```

1. `install -m 0600 /dev/null /etc/htsdesk/api.env` and fill it from
   `.env.example`. Generate keys with `openssl rand -hex 32`.
2. `cp deploy/htsdesk-*.{service,timer} /etc/systemd/system/`
3. `cp deploy/nginx.conf /etc/nginx/sites-available/htsdesk-api` and edit
   the hostname.
4. `systemctl enable --now htsdesk-api htsdesk-ingest.timer htsdesk-diff.timer`
5. Confirm: `curl -s localhost:8099/api/health | jq .counts`

The web app deploys separately (Vercel). Set `HTSDESK_API` to the API
origin, `HTSDESK_API_KEY` to a key from the allowlist, and `SITE_URL` to
the canonical site URL — sitemaps and metadata derive from it.

Leave `HTSDESK_ORIGINS` empty. It is only needed if a third party must call
the API from a browser, and it defaults to denying that.

### Back up accounts.db

`data/htsdesk.db` is a build artifact and can be rebuilt from public sources at
any time. `data/accounts.db` cannot: it holds every account, catalogue, watched
code and alert. It is the only file in this system whose loss is unrecoverable.

```bash
sqlite3 /opt/htsdesk/data/accounts.db ".backup '/backup/accounts-$(date +%F).db'"
```

Use `.backup` rather than copying the file — a plain copy taken mid-write, with
WAL enabled, can be inconsistent.

## Health checks

```bash
curl -s localhost:8099/api/health | jq
```

`counts.hts` should be ~29,850 and `counts.ruling` ~200,960. A materially
lower number means a rebuild ran against an incomplete download; re-run
`make refresh`.

`reasoning_enabled` reports whether `ANTHROPIC_API_KEY` is set. When false the
classifier still runs on ruling precedent alone, at lower accuracy, and says
so in its response notes.

## Common problems

**`database is locked` during ingest.** Two writers. Stop one; see above.

**Audit returns `truncated: true`.** The wall-clock budget was reached. Raise
`HTSDESK_AUDIT_BUDGET` or split the catalogue. Do not raise it far: it is
what stops one request occupying a worker.

**429 from the API.** Rate limiting is working. Supply a key via `X-API-Key`,
or wait the seconds given in `Retry-After`.

**Duty figures look low on Chinese goods.** Expected, and deliberate. Trade
remedies whose scope lives in the Chapter 99 U.S. Notes are withheld rather
than guessed; the response lists them in `scope_unverified` and says so in
`warnings`. Under-stating with disclosure beats inventing duty.

**A copy or layout change does not appear after a build.** Next persists
prerendered pages and ISR output under `web/.next`. An incremental build reuses
them, so an edit can compile successfully and still serve the previous text —
observed with the `/changes` copy, where the build reported success and the old
sentence kept rendering. `make build` clears `.next` first. A running
`next start` also keeps serving its old output, so restart it after building.

**A rate looks wrong.** Check `/api/hts/{code}` — every component carries its
authority. Compare against the current HTS at hts.usitc.gov. If the schedule
moved, run `make refresh`.
