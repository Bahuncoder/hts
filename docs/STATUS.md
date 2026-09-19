# Build status

Last updated 2026-09-19, after the independent audit in `PROJECT-AUDIT.md`.
This is the single place readiness is stated; if it disagrees with another
document, this one has been updated more recently or the other is wrong.

**Launching as a free product; nothing is sold.** The engine's calculation
integrity, refresh pipeline and notification recovery were repaired after the
audit (below). What remains before launch is measurement, coverage and
operations work listed under "Release gate".

On 2026-09-19 the paid model was removed on the owner's decision: no Stripe,
checkout, billing portal, webhooks, subscriptions or pricing page. The durable
webhook/ordering work built for it was deleted with it; it is still in git
history (commit 8150908 and earlier). `subscription` and `webhook_event`
tables in an existing accounts database are left dormant, not dropped.

## Built and tested

| Area | State |
|---|---|
| Chapter 99 rate-line parser | 565/565 lines parsed |
| HTS tree with rate inheritance | 19,949 statistical lines |
| U.S. Notes scope extractor | 67 headings, 12,362 heading/code pairs |
| Duty stack resolver | base + remedies + HMF per line, MPF per entry; every line cites its authority |
| Origin handling | names, ISO codes and aliases resolve to one key; unrecognised origins are refused |
| Rate grammar | ad valorem, quantity-based and unparsed parts separated; omitted parts reported in `incomplete` |
| Preferences | matched to a named program or the one program covering the origin; fixed-membership FTAs eligibility-checked, others flagged as asserted |
| Refresh pipeline | one validated transaction, versioned release directories, indexes rebuilt inside it, engine reloads on revision change |
| Audit API | every row returned with a status, reasons and its own row number; summary reconciles and says whether totals are complete |
| Free model and limits | No payments. Anonymous: 25 products per audit, 3 audits per 10 minutes, 150 items per rolling 24 h. Signed-in account: 200 products per audit, 10 audits per hour, 2,000 items per rolling 24 h, 20 saved catalogues, alert emails on (opt-out). All numbers live in `web/src/lib/plans.ts` |
| Alerts | outbox with exact-id claims, bounded retries, cursor paging with lookback, failures never advance the cursor |
| Public cost controls | request/item budgets per client or account, one audit in flight per caller, streamed body cap |
| Accounts store | libSQL (Turso in production, embedded file in development) |

## Test coverage

| Suite | Count | What it exercises |
|---|---|---|
| `tests/test_duty.py` | 46 | duty arithmetic, refusals, rate grammar, preferences, origins, fees |
| `tests/test_api.py` | 32 | API contract, security regressions, audit row/status behaviour, cursor paging |
| `tests/test_refresh.py` | 10 | index survival, stale-data removal, rollback, engine reload across editions |
| `tests/test_classify_eval.py` | 3 | a held-out ruling cannot vote for itself; reasoning cannot run in evaluation |
| `web` `npm run test:integration` | 85 | real routes over scratch databases with fake engine/mail servers |
| browser suites (`make test-journey`, `test-security`, `test-authflow`, `test-review`) | 67 | customer journey, cross-account access, throttling, CSV/XSS, reset and verify, the audit review workspace and saved catalogues |

The Python suites need `data/` for `test_api`, `test_refresh` and the
evaluation; `test_duty` and `test_classify_eval` run anywhere (CI runs those).

## Classifier accuracy

Measured 2026-09-19 with `tests/eval_classify.py`: 400 cases, retrieval only,
the held-out ruling **and every ruling with the same subject** removed before
scoring, abstentions counted as misses.

| Metric | Result |
|---|---|
| top-1 heading (4-digit) | 46.8% |
| top-1 subheading (6-digit) | 34.8% |
| top-1 8-digit | 29.0% |
| **top-1 exact 10-digit line (what pricing uses)** | **15.0%** |
| top-3 heading | 71.5% |

The figures previously published here (58.2% / 46.2% / 83.0%) were **not**
held-out measurements: the answer had already voted for itself before being
filtered out. They are withdrawn.

What this means for the product: the classifier is a candidate generator with
precedent, not a filing-ready code. The audit already flags classified codes
whose sibling statistical lines carry different rates (`suffix_review`), and
classified rows are never presented as decided. The reasoning layer (needs
`ANTHROPIC_API_KEY`) is unmeasured; measure it with a separate, labelled run
before claiming anything for it.

## Known gaps

- ~78 remedy headings are still unscoped: their notes describe goods in prose,
  so every China/Vietnam-origin line is reported as `scope_review` rather than
  ready. Honest, but noisy; it needs the reasoning layer or manual scoping.
- Quantity-based duties (cents/kg, $/each) need quantity input, which does not
  exist yet: such lines are flagged incomplete, never silently understated.
- AD/CVD orders are not integrated (separate CBP/ITA dataset). For many
  China/Vietnam/India goods this is the largest omitted charge and is **not
  flagged** yet.
- MPF preference exemptions are not modelled; the assumptions list says so.
- The IEEPA "refundable" figure is a scenario estimate for one entry at the
  entered value. There is no entry date, paid duty or liquidation status, so it
  cannot substantiate a refund claim; the UI is worded accordingly.
- The classifier's exact-line accuracy is low (above).
- Alerts replay 7 days behind the cursor; a document ingested more than a week
  after its publication date is still missed.
- Re-pricing a saved catalogue is not built.
- Not built: entry-summary (CBP 7501) ingest, duty drawback, team seats, API
  access.
- MPF/HMF constants are FY2026; `FEE_CONSTANTS_EFFECTIVE_THROUGH` warns from
  2026-10-01 but the FY2027 values must still be entered by a person.

## Release gate

All must be true before launch:

- [x] A refreshed dataset produces consistent, versioned quotes; a removed code
      or changed rate is reflected by every endpoint (`test_refresh`).
- [x] Unsupported inputs never look complete: invalid codes/origins are errors,
      omitted duty components are flagged.
- [x] Failed email work recovers; retries are not discarded.
- [x] Every imported row is accountable end to end: sent with its row number,
      returned with a status, saved, exported, and counted in the reconciliation
      (`web/tests/review.test.mjs`, browser).
- [x] Integration tests exercise production routes, over isolated databases.
- [ ] Reasoning layer measured, or the product described without it.
- [ ] AD/CVD at least flagged for affected origins.
- [ ] FY2027 fee constants entered (due 2026-10-01).
- [ ] Deployed to real Vercel/Turso/VPS with monitoring and offsite backups,
      and real email delivery exercised.
- [ ] Terms, privacy and disclaimers reviewed by a customs attorney.
