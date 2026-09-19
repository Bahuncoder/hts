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

Runs the web build, the duty, refresh and classifier-evaluation suites, the API
contract and security regressions, the web integration suites (real routes over
scratch databases with fake Stripe, engine and mail servers) and the browser
suites. The API must be running for `test_api` (start it with
`HTSDESK_API_KEYS=testkey123`); it says so if it is not. No test may touch
`data/accounts.db`: the web tests create their own scratch database and refuse
to use an existing one unless `HTSDESK_TEST_ALLOW_EXISTING_DB=1` is set.

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

### What a refresh does

1. Downloads the schedule and Chapter 99 PDF into a new immutable directory,
   `data/releases/<utc timestamp>/`, and refuses to continue if the files look
   truncated (schedule under 20,000 rows, no 9903 headings).
2. Builds the reference data in **one transaction**: clears and refills the
   schedule, remedy rules and scope, rebuilds both search indexes, then
   validates the result against absolute floors and the previous build (no more
   than 10% shrink, every ruling and schedule line indexed). If validation
   fails the transaction rolls back, the previous data keeps serving, and the
   command exits non-zero with `BUILD REJECTED`.
3. On success records the new `dataset_revision` and `release_dir`. The API
   compares the revision on every request and reloads its engine (and clears the
   classifier's caches) the first time it changes, so lookups and quotes never
   disagree about the edition. Every quote and audit names its revision.
4. Keeps the three newest releases; the older ones are deleted.

Rollback: point the database at an earlier release by re-running
`python3 ingest/build.py --release data/releases/<older>`.

`make check` does not need a live refresh; `tests/test_refresh.py` proves the
mechanism against a scratch database, including a removed code and a changed
rate across two editions.

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
second pass over the same window creates nothing.

`diff_state` holds a composite cursor (`publication_date|document_number`), not
just a date, and each run re-reads a 7-day lookback window behind it, so a page
that ended part-way through a date or a document ingested a little late is still
seen. The cursor moves only after every page was fetched and the alerts were
committed; a failed engine call is reported as `ran: false` and changes nothing.
With no stored cursor (new install, or one that was lost) a run starts 30 days
back, not at the beginning of history, so no customer is alerted about old
actions on day one. Pass `?since=YYYY-MM-DD` to backfill further deliberately. A
document ingested more than a week after its publication date is still missed.

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
- **Skips are stamped; failures are not.** An alert skipped by design (free
  plan, opted out, no provider configured) is stamped with its reason, so it is
  never replayed as a backlog when the account upgrades or a key is added. A
  *failed* send is different: the alert stays queued, the attempt and error are
  recorded (`email_attempts`, `email_last_error`), and the next run retries it.
  After 5 attempts it is stamped `failed_permanent` and logged. Delivery claims
  the exact alerts it renders, so an alert inserted mid-send is not stamped
  without being emailed and two concurrent runs cannot send the same batch.

Unsubscribe links are signed with `HTSDESK_EMAIL_SECRET` and work without a
session — someone who no longer wants our mail should not have to sign in to
stop it. Turning emails off leaves watched codes and in-app alerts untouched.

## Deploying

The API and the web app deploy independently — see `docs/DEPLOY.md` for the
full walkthrough of both. Summary:

```bash
sudo ops/install.sh     # idempotent; never overwrites /etc/htsdesk/*.env
```

Creates the service user, installs the API, generates secrets on first run,
pulls the reference data, and enables the API, ingest and diff-trigger units.
It does not build or run the web app — that has no persistent local state of
its own and deploys to Vercel separately. Then fill in the provider keys,
point nginx at your hostname, and re-run `make preflight` until it reports no
failures.

```
/opt/htsdesk            application, owned by the htsdesk user
/opt/htsdesk/data       reference DB — the only writable path on this host
/etc/htsdesk/api.env    credentials, root-owned, mode 0600
```

1. `install -m 0600 /dev/null /etc/htsdesk/api.env` and fill it from
   `.env.example`. Generate keys with `openssl rand -hex 32`.
2. `cp deploy/htsdesk-*.{service,timer} /etc/systemd/system/`
3. `cp deploy/nginx.conf /etc/nginx/sites-available/htsdesk-api` and edit
   the hostname.
4. `systemctl enable --now htsdesk-api htsdesk-ingest.timer htsdesk-diff.timer`
5. Confirm: `curl -s localhost:8099/api/health | jq .counts`

The web app deploys separately (Vercel). Set `HTSDESK_API` to the API
origin, `HTSDESK_API_KEY` to a key from the allowlist, `SITE_URL` to the
canonical site URL — sitemaps and metadata derive from it — and
`TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` for the accounts database.

Leave `HTSDESK_ORIGINS` empty. It is only needed if a third party must call
the API from a browser, and it defaults to denying that.

### Preflight

```bash
make preflight
```

Checks what's controllable from the API host: reference data loaded, secrets
present and not trivially short, CORS closed. Stripe keys, the email secret
and the accounts database live in the web app's Vercel environment now, so
they are not checked here — verify those with `vercel env ls` before a web
deploy. Failures exit non-zero; warnings are for capabilities that are simply
not switched on yet.

### Back up account data

`data/htsdesk.db` (on the API host) is a build artifact and can be rebuilt
from public sources at any time. The accounts database — every account,
catalogue, watched code and alert — lives in Turso, not on either host, and
Turso's own scheduled backups or `turso db shell htsdesk .dump` are the
production backup path; see `docs/DEPLOY.md`.

`make backup` / `make restore` (`ops/backup-accounts.py`,
`ops/restore-accounts.py`) still work, but only against the local
embedded-file fallback used when `TURSO_DATABASE_URL` is unset — they read a
SQLite file directly and cannot see a remote Turso database. Restore is
deliberately manual — it asks you to type RESTORE, and keeps the file it
replaces alongside.

## Health checks

```bash
curl -s localhost:8099/api/health | jq
```

`counts.hts` should be ~29,850 and `counts.ruling` ~200,960. Counts alone are
not enough — the failure that matters is an index that no longer covers its
table while the table looks fine — so also check:

- `status` is `ok` (it is `degraded` when the precedent index is empty or does
  not cover every ruling; an unkeyed call reports only the empty case);
- `index_complete` is `true` and `index.rulings_indexed == index.rulings`;
- `engine_current` is `true` (or `null` before the first quote). `false` means
  the engine has not yet reloaded the database's `dataset_revision`;
- `fee_constants_stale` is `false`.

A materially lower count, or an incomplete index, means a build was interrupted
outside the validated path (for example `cross.py` killed mid-reindex); re-run
`make refresh`. `make preflight` checks the same things.

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
