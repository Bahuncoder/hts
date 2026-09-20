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
| U.S. Notes scope extractor | 69 headings, 12,362 heading/code pairs; note 52's exceptions are read as separate statements (targets, list, claimed agreement) |
| Duty stack resolver | base + remedies + HMF per line, MPF per entry; every line cites its authority |
| Origin handling | names, ISO codes and aliases resolve to one key; unrecognised origins are refused |
| Rate grammar | ad valorem, quantity-based and unparsed parts separated; per-unit duties are priced from an optional quantity (units convert within a dimension), and anything not priced is reported in `incomplete` |
| Deal-rate math | U.S. note 52(k): EU, Japan, Korea, Switzerland and Taiwan duties top the total up to 10 / 12.5 %, decided by the line's ad valorem equivalent (needs the quantity when the base rate is per-unit) |
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
| `tests/test_regimes.py` | 17 | Chapter 99 regimes on the real schedule: what is charged, exempt, expired, or unknown |
| `tests/test_api.py` | 35 | API contract, security regressions, audit row/status behaviour, cursor paging |
| `tests/test_refresh.py` | 10 | index survival, stale-data removal, rollback, engine reload across editions |
| `tests/test_classify_eval.py` | 3 | a held-out ruling cannot vote for itself; reasoning cannot run in evaluation |
| `web` `npm run test:integration` | 86 | real routes over scratch databases with fake engine/mail servers |
| browser suites (`make test-journey`, `test-security`, `test-authflow`, `test-review`) | 67 | customer journey, cross-account access, throttling, CSV/XSS, reset and verify, the audit review workspace and saved catalogues |
| browser suites (`make test-ui`, `test-draft`, `test-contrast`) | 42 | workspace UI and self-hosted fonts (10), audit-survives-sign-up draft and `?next=` allowlist (21), measured WCAG contrast in light/dark (11) |

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

- **Chapter 99 scope, what is and is not resolved.** The schedule's country-wide
  duties (U.S. note 52: 10–12.5% on about 55 economies, the regime that replaced
  the Section 122 surcharge on 2026-07-24) are applied to every product of the
  origin *except* the note's own exception lists, which are extracted from the
  schedule text. A China, Vietnam, India, Philippines... quote for an ordinary
  consumer product is therefore complete and states its assumption (no
  entry-specific exemption: goods in transit, donations, informational
  materials, Chapter 98 claims). Products on the note's pure code-list exceptions
  are exempt; products on its use-conditional lists (civil-aircraft parts,
  pharmaceutical articles) are exempt only when the importer states that end
  use. Still flagged, deliberately (fail closed): whole vehicles, pharmaceutical (232) and semiconductor articles, and every
  deal origin's own structure for vehicle parts and upholstered furniture.
  Section 232 metals (note 16), vehicle parts (notes 33, 38) and wood (note 37)
  are resolved: metals need the metal weight only outside chapters 72-76;
  vehicle parts need the importer to say whether the goods are parts of a
  passenger vehicle, a heavy-duty vehicle, or neither; a stated use never
  comes from the code. The note-52 civil-aircraft and pharmaceutical
  exceptions apply only on a stated end use and are otherwise assumed
  unclaimed (the quote says so). Whatever the quote could not settle names the
  fact that would settle it (`facts_needed`).
  Origins with a deal structure are resolved for ordinary goods: the UK,
  Malaysia, Taiwan and others take only their own exception list; Canada and
  Mexico owe the note-52 duty unless USMCA free treatment is claimed (`program`
  `S`); Guatemala and El Salvador likewise for CAFTA-DR (`P`); a claim is
  assumed to qualify. Measured on a 1,500-line sample (metals chapters 72, 73,
  76 excluded) with no facts stated: 79.8 % of quotes are complete for China,
  Canada and the UK (Germany 79.7 %, Japan 77.8 %); with a quantity for every
  per-unit line, 90.4 % (Japan 88.1 %); with metal weight and vehicle use also
  stated, 94.9 % (China). At the previous commit Germany and Japan were 0 %.
  What is left is whole vehicles and heavy-duty vehicles, deal-origin (EU,
  Japan, Korea, Taiwan, UK) vehicle parts, pharmaceutical 232 and
  semiconductors, and per-unit forms it cannot price (sliding scales, "on
  copper content").
  Found and fixed while building this: 121 rules named a Chapter 99 exception
  as their base subheading and never matched (all 9903.02 reciprocal duties
  among them); note 51's three Canada headings shared one merged 554-code list;
  the 9903.02 reciprocal duties are IEEPA and now feed the refund estimate
  (flagged unscoped) instead of vanishing; U.S. note 31 (Section 301) had been
  counted as a Section 232 note, flagging its 990 lines for every origin.
- **Two editorial facts must be re-verified each refresh.** The engine reads
  expiry from the schedule's compiler's notes where they exist, but the
  Section 122 surcharge (9903.03.01–.11) is not yet marked expired there, so its
  expiry on 2026-07-24 is an editorial override in `core/regimes.py`
  (`KNOWN_EXPIRED`), taken from Proclamation 11012 and public reporting. The
  reading of note 52 (apply to everything not excepted) follows the note's own
  text in 52(a) but has not been confirmed by a customs broker or attorney.
- Quantity-based duties (cents/kg, $/each) are priced only when the caller
  gives a quantity (calculator field; `quantity`/`unit` audit columns). Without
  one the line is flagged incomplete and says which unit to enter (about 13 %
  of lines carry such a duty). The customs value is the entered value; no
  proof-gallon, drained-weight or metal-content basis is modelled.
- Section 232 defaults are assumptions the quote states: the ordinary metals
  rate (no 85 % U.S.-melted, 95 % U.K. or use-in-U.S.-manufacturing claim), no
  manufacturer import-adjustment offset, and no importer certification for
  automobile parts outside the enumerated list. These can only raise the
  estimate. Not modelled: whole vehicles, the deal-origin vehicle-part and
  furniture headings, pharmaceutical (note 40) and semiconductor (note 39)
  articles.
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
