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
| Sign-in | email/password, plus optional "Continue with Google" (authorization-code flow, state-cookie CSRF check, unverified emails refused) when `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are set; unset, the button does not render and the route 404s |
| Accounts store | libSQL (Turso in production, embedded file in development) |
| Landed cost | currency conversion for additional costs (goods and duty stay USD; a dated rate and source are recorded with the save, never a fetched live rate) and per-product allocation (by goods value or equally, largest-remainder cents so shares always sum exactly) |
| Evidence package | JSON export and printable/PDF report both carry the classifier's supporting ruling snapshots (excerpt, subject, date, revoked, `rulings.cbp.gov` URL only) and the full reviewer/approval history, both bounded and projected before signing |
| Auth race safety | credential-endpoint throttling, single-use reset/verify tokens, and a credential reset's session wipe are each one atomic SQL statement or transaction, not a check followed by a separate write; verified under genuine concurrency (`web/tests/auth-races.test.mjs`), including across independent database connections, not just one shared client |

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
| `web` `npm run test:google` | 12 | Google sign-in against a fake Google: new/existing account, unverified email, cancelled consent, CSRF and single-use state, feature-off gating |
| `web/tests/auth-races.test.mjs` (now part of `test:integration`) | 8 | throttling, token redemption and a credential reset under genuine `Promise.all` concurrency, including across independent DB connections, not sequential calls |

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
  use. Still flagged, deliberately (fail closed): whole vehicles,
  pharmaceutical (232) and semiconductor articles, and the U.K.'s
  vehicle-parts heading (its "10%" does not say what it is a rate on).
  Section 232 metals (note 16), vehicle parts (notes 33, 38) and wood (note 37)
  are resolved: metals need the metal weight only outside chapters 72-76;
  vehicle parts need the importer to say whether the goods are parts of a
  passenger vehicle, a heavy-duty vehicle, or neither; a stated use never
  comes from the code. For the EU, Japan, South Korea and Taiwan the parts and
  upholstered-furniture headings are their own: parts are topped up to 15%
  (unless the column 1 rate is already 15% or more), furniture and cabinets are
  15% flat (every code on those lists is duty-free at column 1); the U.K.
  furniture heading adds 10%. The note-52 civil-aircraft and pharmaceutical
  exceptions apply only when the importer states that end use and are
  otherwise assumed unclaimed (the quote says so). Whatever the quote could
  not settle names the fact that would settle it (`facts_needed`).
  Origins with a deal structure are resolved for ordinary goods: the UK,
  Malaysia, Taiwan and others take only their own exception list; Canada and
  Mexico owe the note-52 duty unless USMCA free treatment is claimed (`program`
  `S`); Guatemala and El Salvador likewise for CAFTA-DR (`P`); a claim is
  assumed to qualify. Measured on a 1,500-line sample (metals chapters 72, 73,
  76 excluded) with no facts stated: 79.8 % of quotes are complete for China,
  Germany, Korea, Taiwan and the UK (Japan 77.9 %); with metal weight, vehicle
  use and a quantity for every per-unit line, 94.9 % for China, 94.4 % for
  Germany, Korea and Taiwan, 92.2 % for Japan, 92.6 % for the UK. At the
  measurement's start Germany and Japan were 0 %.
  What is left is whole vehicles and heavy-duty vehicles, the U.K.'s parts
  heading, pharmaceutical 232 and semiconductors, and per-unit forms it cannot
  price (sliding scales, "on copper content").
  **Expired provisions.** The schedule marks an expired provision only by
  yellow shading in the PDF, which the extracted text loses, so old sanctions
  read as live duties: a 200% replacement rate on every cheese and wine quote,
  25% on every tire quote, 100% on Japanese tools and computers, and a 100%
  crane duty on every origin. `ingest/shading.py` now reads the shading (it
  needs poppler and Pillow; the refresh aborts if it finds nothing), the notes'
  own statements ("suspended pursuant to executive action", "no duty after the
  close of ...") and each provision's stated effective dates are applied, and a
  note that names the country for a list of headings supplies it to headings
  that do not.
  Found and fixed while building this: 121 rules named a Chapter 99 exception
  as their base subheading and never matched (all 9903.02 reciprocal duties
  among them); note 51's three Canada headings shared one merged 554-code list;
  the 9903.02 reciprocal duties are IEEPA and now feed the refund estimate
  (flagged unscoped) instead of vanishing; U.S. note 31 (Section 301) had been
  counted as a Section 232 note, flagging its 990 lines for every origin.
- **One editorial fact must be re-verified each refresh.** The engine reads
  expiry from the compiler's notes, the schedule's yellow shading and each
  provision's stated dates. The published shading agrees that the Section 122
  surcharge (9903.03.01–.11) has expired, so its 2026-07-24 date in
  `core/regimes.py` (`KNOWN_EXPIRED`) is corroborated; but the shading lags
  the law in places (9903.91.04 ended 2026-01-01 and is still unshaded), which
  is why stated dates are applied as well. The
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
  estimate. Not modelled: whole vehicles, the U.K.'s vehicle-part heading,
  importer-certified automobile parts, pharmaceutical (note 40) and semiconductor (note 39)
  articles.
- **Antidumping and countervailing duty (AD/CVD) orders are flagged, not priced.**
  `ingest/adcvd.py` reads the thirteen latest monthly "Opportunity To Request
  Administrative Review" notices (every order in effect, 713 of them, by
  country and case number) and searches each case's full notice history —
  not just its most recent notices — for whichever one states its scope's HTS
  numbers most fully; 706 of 713 (99.0%) now resolve one, up from 683 (95.8%)
  before three extraction bugs were fixed. A quote whose code and origin match
  an order is marked incomplete, names the case, and leaves out the cash
  deposit, which depends on the exporter.
  Three correctness fixes matter here specifically because a wrong match
  would be worse than a missed one: (1) a case number appearing anywhere in a
  notice's text — a footnote citing a companion proceeding, a combined notice
  for several countries — does not mean the notice is about that case, so a
  candidate is only accepted when the case is one of the numbers the Federal
  Register brackets at the top of the notice, where it states which case(s)
  it concerns; (2) the plain-text conversion wraps prose to a fixed width, so
  an ordinary word can start a new line by chance mid-sentence ("the Final
  LTFV\nDetermination to reflect..."), which previously looked enough like a
  section heading to cut a scope's extraction short — a stop now requires the
  phrase to sit alone on its own line; (3) a correction notice or a
  circumvention finding can contain the literal words "antidumping duty
  order" or "final determination" without ever stating the scope, and was
  able to outrank — so get tried before — the actual order, continuation or
  suspension notice that carries it. `tests/test_adcvd.py` pins all three
  bugs with fixtures reproducing them.
  Limits that remain, all stated by the product: Commerce lists HTS numbers
  "for convenience" (the written scope decides), so a product an order covers
  but does not list is missed; an order whose scope lists no HTS number
  cannot be matched (counted per quote as unchecked); no scope rulings,
  circumvention findings, exclusions or exporter rates are read. A fourth
  ranking bug (a genuine order notice with a compound title — "Termination
  of Suspension Agreement, Rescission of Administrative Reviews, and
  Imposition of an Antidumping Duty Order" — was misread as a review notice
  over the bare word "review" appearing in an unrelated side-clause) is
  also fixed, verified against a zero-regression rebuild, but resolved none
  of the 7 by itself. Each of the 7 has now been individually diagnosed,
  not just counted: Fresh Tomatoes From Mexico (A-201-820) — the real order
  notice is now correctly found and read, but its scope lists a bare
  4-digit heading ("0702.", no subheading digits), which no current pattern
  in `scope_hts()` matches; extending it safely needs validation against
  the whole corpus, not attempted yet. Cambodia's photovoltaic-cell CVD
  order (C-555-003) — working as designed: the one notice found with a
  matching HTS list is a combined multi-country order whose own header
  correctly excludes this case's number (not a false exclusion); a
  separate, case-specific notice exists but was not located by the
  case-number search. The other 5 were not further diagnosed. The absence
  of a flag is not proof that no order applies.
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
- [x] AD/CVD flagged for affected origins (coverage limits above).
- [ ] FY2027 fee constants entered (due 2026-10-01).
- [ ] Deployed to real Vercel/Turso/VPS with monitoring and offsite backups,
      and real email delivery exercised.
- [ ] Terms, privacy and disclaimers reviewed by a customs attorney.
