# Runbook

Day-to-day operation. For architecture see `README.md`; for the audit findings
see `SECURITY.md`.

## Local development

Two processes. The API owns the data and the engine; the web app renders and
proxies.

```bash
make api                                    # :8099
TARIFFWISE_API=http://127.0.0.1:8099 make web   # :3000
```

The web app talks to the API server-side only. Browsers never call the API
directly, so no CORS configuration is needed locally.

To exercise the paid limits and the audit proxy:

```bash
TARIFFWISE_API_KEYS=devkey make api
TARIFFWISE_API_KEY=devkey TARIFFWISE_API=http://127.0.0.1:8099 make web
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

`deploy/tariffwise-ingest.timer` runs the daily refresh at 09:00 UTC, ahead of
the US business day.

`make rulings` is resumable and idempotent — it fetches only rulings whose body
is still missing, newest first. Stopping it loses nothing; progress is
committed in batches of 500.

### Ingest writes and the write lock

SQLite takes a single writer. The body ingest and the Federal Register poller
both write, and running them together produces `database is locked`. Run them
one at a time. The API is unaffected: it opens read-only and WAL lets readers
proceed during writes.

## Deploying

```
/opt/tariffwise            application, owned by the tariffwise user
/opt/tariffwise/data       reference DB — the only writable path
/etc/tariffwise/api.env    credentials, root-owned, mode 0600
```

1. `install -m 0600 /dev/null /etc/tariffwise/api.env` and fill it from
   `.env.example`. Generate keys with `openssl rand -hex 32`.
2. `cp deploy/tariffwise-*.{service,timer} /etc/systemd/system/`
3. `cp deploy/nginx.conf /etc/nginx/sites-available/tariffwise-api` and edit
   the hostname.
4. `systemctl enable --now tariffwise-api tariffwise-ingest.timer`
5. Confirm: `curl -s localhost:8099/api/health | jq .counts`

The web app deploys separately (Vercel). Set `TARIFFWISE_API` to the API
origin, `TARIFFWISE_API_KEY` to a key from the allowlist, and `SITE_URL` to
the canonical site URL — sitemaps and metadata derive from it.

Leave `TARIFFWISE_ORIGINS` empty. It is only needed if a third party must call
the API from a browser, and it defaults to denying that.

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
`TARIFFWISE_AUDIT_BUDGET` or split the catalogue. Do not raise it far: it is
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
