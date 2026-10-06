# Launch checklist

Status as of 2026-10-06. "Verified" means run against local data and isolated
services; nothing here has been checked on the deployed system yet.

## Decided

| Decision | Choice | Why |
|---|---|---|
| Freshness limits | HTS schedule 45 days, rulings 30, Federal Register poll 3 | Matches how often each source moves |
| Alert provider | Resend (Postmark works the same way) | First provider in the code; one key |
| Classification at launch | Launch only with every suggestion labelled as a suggestion, and no accuracy claim in the copy | Exact-code top-1 accuracy is 15.5% (docs/STATUS.md) |
| Paid plans | Launch free-only; billing follows once live keys are set | Live payment setup is not verified |
| Real-data gate | Three importers run their own product lists before launch | Every check so far used simulated engine data |
| Production apply | Someone with server access applies `deploy/` | No production access from the development environment |

## Done in the repository

- Security audit findings S01 to S06 fixed, with regression suites
  (`web/tests/security-audit-2026-10-06.mjs`, `origin`, `budget-race`,
  `apikey-limit-race`). Dependencies patched; live npm audit: zero known
  vulnerabilities.
- Production build passes (`npm run build`).

- Freshness judgement and health status `stale` (`ops/freshness.py`, `/api/health`), tests 9/9.
- Operator alerts by email, one per change plus recovery, and an alert on failed refresh (`ops/alerts.py`), tests 6/6.
- Refresh records each outcome (`data/refresh_status.json`), tests 10/10.
- Daily alert timer and weekly ruling ingest timer (`deploy/htsdesk-alerts.*`, `deploy/htsdesk-rulings.*`).
- Runbook and deploy guide cover freshness, alerts and the new timers.
- Production service passes `--no-server-header`.

## Open: needs you

- [ ] Set `HTSDESK_OPS_EMAIL` in `/etc/htsdesk/api.env` (suggested: your address).
- [ ] Create the Resend account and set `RESEND_API_KEY` in the same file.
- [ ] Find three importers and get their product lists run before launch.
- [ ] Legal read of terms, privacy policy and the duty disclaimer.
- [ ] Copy review: no accuracy claim beyond "suggestions to confirm".

## Open: needs production access

- [ ] Apply `deploy/` (API, ingest, diff, alerts and rulings units) and enable the timers.
- [ ] Confirm the live API response has no `Server` header (the local check failed on the header, so verify it on the real service).
- [ ] Trigger one alert on purpose (for example, set `HTSDESK_MAX_BUILD_AGE_DAYS=0` for one run) and confirm the email arrives.
- [ ] Deployed monitoring: poll `/api/health` and alert on any status other than `ok`.
- [ ] Offsite backups of account data, with one restore drill from them.
- [ ] Live email delivery for verification, password reset and alerts.
- [ ] Live billing webhooks, only if paid plans launch.

## Verify before launch

- [ ] Refresh and ruling ingest have each run successfully on the production schedule.
- [ ] The local data is current: at the time of writing, rulings (August 24) and the Federal Register poll are stale, so health reports `stale`.
- [ ] Re-measure classifier accuracy after the corpus changes (`tests/eval_classify.py`).
- [ ] Full suite run against the release candidate.

## How to check the system

- Health: `curl -s https://<api>/api/health` (`status` should be `ok`). With a key, `freshness` shows each source's age.
- Alerts: `make alerts` runs the check once and prints what it did.
- Refresh outcome: `data/refresh_status.json`.
