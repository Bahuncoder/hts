# HTSDesk project audit — 2026-09-19

Verdict: substantial working prototype, but not ready to be relied on as a paid duty-calculation and monitoring product. The architecture is workable; the release blockers are correctness, data refresh, billing recovery, and evidence quality. A framework rewrite would not resolve these issues.

Scope: Python engine/API/ingest, Next.js account/audit/catalogue/billing/alerts paths, tests, deployment scripts, and source-level comparison with the Audit and BrandSystem design references. Findings distinguish executable reproductions from source inspection. This is not a certification of current tariff law or every tariff rule, and no browser accessibility, performance, or responsive pass is claimed.

## Highest-priority findings

### 1. High — daily refresh destroys the ruling search index

Evidence: `ingest/build.py:64-79` drops and recreates `ruling_fts` without inserting the existing rulings. `ingest/refresh.py` calls this builder but does not rebuild CROSS search. `core/classify.py:144-155` retrieves precedent exclusively through that index.

Reproduced in an in-memory database: one indexed ruling before `build_fts`, zero afterward. Existing ruling records and health counts can remain intact, concealing the damage.

Impact: a routine scheduled refresh removes the classifier's precedent retrieval until a separate process repopulates the index.

Fix: preserve the index or repopulate it from all current ruling records, build a complete candidate snapshot, and verify index coverage before promotion. Regression: refreshing a seeded corpus preserves retrieval of every expected ruling.

### 2. High — refreshed reference data and running quotes can disagree indefinitely

Evidence: `api/main.py:79-87` caches the engine for the process lifetime; `core/classify.py:159-176` also caches leaf resolutions. The ingest service performs refresh without reloading API workers. `ingest/build.py:31,44,57,60` upserts records without removing codes/scopes absent from a new edition. FTS rebuild is performed in the live database.

Impact: lookup/health data can reflect a new edition while calculations use old rates; removed codes/scopes survive rebuilds. A partially failed refresh can leave mismatched raw files and database state.

Fix: version immutable snapshots, validate them before publication, atomically switch the active version, and reload/invalidate workers and caches. Include dataset revision in every quote and saved result. Regression: remove a code and change a rate in a second fixture edition; all endpoints must agree after promotion and old data must disappear.

### 3. High — invalid HTS codes receive successful audit quotes

Evidence: `api/main.py:285` calls `eng.quote` directly, bypassing the code-existence/leaf checks in `/api/quote`. `core/hts.py` returns an empty rate for a missing code, and `core/duty.py:118-120` interprets it as zero duty.

Reproduced through FastAPI TestClient: `/api/audit` with `hts=NOT-A-CODE`, Vietnam, and $10,000 returned HTTP 200, confidence `given`, and duty/fees of $47.14. It did not report an invalid code.

Fix: validate canonical, existing statistical lines inside the engine so every caller inherits the rule. Invalid and unsupported lines must retain their original input and an explicit error, never a normal numeric quote.

### 4. High — origin spelling silently changes duty

Evidence: `core/duty.py:143-155` matches country names literally; API/catalogue country fields accept arbitrary strings.

Reproduced with local reference data for `6109.10.00.12`, $10,000: `China` returns $2,447.14 while `CN` returns $1,697.14. The $750 Section 301 component disappears, and the CN result has no warning.

Fix: use canonical country identifiers, normalize recognized names/aliases at the boundary, and reject unknown origins. Regression: recognized equivalents must produce identical results; typos must not fall through to an ordinary-origin quote.

### 5. High — base-rate parsing can silently omit duty and misselect preferences

Evidence: `core/duty.py:118-128` recognizes only a narrow cents-per-unit grammar and takes the first percentage; `core/duty.py:204-205` selects an entire special-rate cell using only a boolean claim.

Executable parser examples: `$1/kg + 5%` yields 5% with no specific-duty warning; `Free (CA), 5% (MX)` yields 5% regardless of origin; `Free (A, CA, MX)` is considered unparsed. No program-to-country eligibility mapping is applied.

Fix: parse rate cells into typed components and country/program alternatives. Require quantities for specific duties and an identified preference program/eligibility assertion. Unsupported expressions need an explicit incomplete result, not a silent zero or partial rate. Test real schedule formats plus malformed cells.

### 6. High — catalogue fee totals have no shipment model

Evidence: every audit item calls the engine with default formal-entry and vessel assumptions (`api/main.py:285`); `core/duty.py` applies MPF minimum/maximum separately to each invocation. The CSV model has no entry grouping, transport or quantity fields. The calculator also omits transport controls.

Impact: if rows belong to one entry, the minimum/maximum is applied repeatedly. For example, ten $100 zero-base-duty lines produce $335.80 MPF under per-row calculation versus one $33.58 minimum for one qualifying formal entry. If rows represent separate entries, that assumption needs to be explicit. Preference-based MPF exemptions are not modeled. CBP confirms the fee structure and that many preference programs provide exemptions: https://www.help.cbp.gov/s/article/Article-1128?language=en_US

Fix: model entry/shipment separately from product lines, aggregate entry-level fees correctly, and expose transport/entry type and applicable exemptions. Until then, present a documented per-entry scenario rather than an unexplained catalogue total.

### 7. High — warnings and unresolved products disappear from the audit workflow

Evidence: `api/main.py:294-304` returns scope flags but drops `q.warnings`; pricing errors do not increase the summary review counters. `AuditClient.tsx:145` silently filters invalid rows before submission, `:254` counts only scope/unclassified issues, and `:357` removes error rows before saving.

Impact: missing quantity, unsupported rate, stale-fee and content-basis warnings disappear. Low-confidence or pricing-failed rows are not reliably represented in “Needs review.” Saved results can omit unresolved products.

Fix: define shared row states and reconcile submitted/valid/processed/priced/unresolved counts across API, UI, saved catalogue and export. Preserve every source row, warnings and provenance. Partial totals need their status next to the amount. Test mixed valid/invalid/unclassified/low-confidence/failed/unprocessed inputs end to end.

### 8. High — failed Stripe events cannot recover through retries

Evidence: `web/src/app/api/stripe/webhook/route.ts:42-52` claims the event before applying it. `web/src/lib/store.ts:340` persists that claim immediately; the handler never releases or transitions it after failure. Claim errors of every kind are treated as duplicates.

Impact: if subscription retrieval or persistence fails after the claim, the first request returns 500, but a retry returns 200 duplicate without applying the subscription. A database error during the claim can also be falsely acknowledged.

Fix: durable received/processing/succeeded/failed states with retry recovery, or an appropriate transaction for database-only work. Only genuine uniqueness conflicts are duplicates. Test a forced failure after claiming followed by redelivery through the real route.

### 9. High — out-of-order subscription events overwrite newer entitlements

Evidence: webhook subscription handlers write event snapshots without a version/order guard or current-state reconciliation (`route.ts:75-92`). Event-ID deduplication only handles the same event ID.

Impact: an older distinct update can overwrite an upgrade/cancellation; deletion of an older subscription can clear an account's newer subscription because updates are keyed by account.

Fix: reconcile the authoritative subscription state and identity, serialize account updates where necessary, and make old-subscription events harmless. Stripe documents retries, duplicate deliveries and lack of ordering guarantees: https://docs.stripe.com/webhooks

### 10. High — alert emails are permanently discarded after transient failure

Evidence: `web/src/lib/diff.ts:237-247` stamps `emailed_at` even when `send` returns failed. The stamp updates every currently pending alert for the account rather than the exact IDs included in the rendered digest.

Impact: a provider outage permanently loses paid notifications; an alert inserted during sending can be stamped without being included. Concurrent delivery runs can also select the same pending batch.

Fix: introduce an outbox/delivery state with bounded retries and idempotency, and mark only the exact successfully delivered alert IDs. Keep intentionally skipped notifications separate from failures. Test provider failure/recovery and concurrent inserts/runs.

### 11. High — date-only alert pagination skips documents

Evidence: `api/main.py:356` filters `publication_date > since`; `web/src/lib/diff.ts` requests a limited page and advances to its last date.

Impact: if a page ends mid-date, remaining documents for that date are never fetched. Documents ingested later with the same or an older publication date are also missed. Additionally, HTTP errors become `[]` at `diff.ts:35`, so a failed fetch can be recorded as a successful empty run.

Fix: stable composite pagination and a replay/lookback window backed by document-ID deduplication. Surface fetch failure explicitly and track last successful coverage. Regression: more than one page on the same date plus a late-arriving document.

### 12. High — public web traffic bypasses engine cost controls

Evidence: `web/src/app/api/audit/route.ts` attaches the engine key for anonymous callers, checks per-request item count, but has no caller rate/concurrency budget. `api/security.py` exempts keyed calls from its limiter. Server-rendered classification similarly uses the shared key.

Impact: a user can submit repeated requests within the free item ceiling; upstream nginx may limit aggregate web-origin traffic but cannot implement account-level quotas here. Expensive work can consume capacity for all visitors. The body cap is checked only after buffering the request; JSON `null` also passes parsing and then causes a property-access failure.

Fix: enforce per-client/account work budgets at the public web boundary, including concurrency and classification cost, validate body shape and stream/edge size limits, and retain upstream global protection. Test the proxy, not only direct Python API calls.

### 13. High — classifier accuracy evaluation is contaminated by the answer

Evidence: `tests/eval_classify.py:61-67` calls classification before filtering source-ruling evidence. A candidate containing the source ruling is retained when it has multiple rulings; its score has already benefited from that source. Cases with no surviving candidates are skipped from the denominator.

Impact: the documented “held-out” results are not clean held-out measurements. This does not establish the true accuracy in either direction; the published numbers need to be withdrawn/relabelled and remeasured.

Fix: exclude held-out rulings before retrieval/scoring, split near-duplicate products appropriately, count abstentions/failures, and evaluate the exact output granularity used to price products. Version corpus and evaluation fixtures. Ensure retrieval-only evaluation cannot accidentally enable the optional paid reasoning path.

## Product and engineering findings

### 14. Medium — a complete 10-digit classification is implied without sufficient evidence

`core/classify.py:162-175` truncates ruling references to eight digits and selects the first statistical leaf. The audit automatically prices the top candidate, while documented evaluation measures only four/six digits. An arbitrary suffix may not describe the goods. Return unresolved statistical choices and required facts; measure exact-code correctness or abstain before presenting a filing-ready code. Confidence is a heuristic, not a calibrated probability.

### 15. Medium — refund figures lack the historical inputs needed to substantiate recovery

`core/duty.py:226-233` derives a refundable amount from code/origin/current entered value and a prefix rule. There is no entry date, assessed/paid duty, liquidation state, or historical revision in the request. Regardless of the underlying legal position, this establishes a scenario estimate, not that a customer actually paid or can recover that amount. Label it accordingly and separate historical entry analysis from current quotation. This audit does not independently validate the repository's IEEPA legal assertions or prefix coverage.

### 16. Medium — saved catalogues are snapshots without the advertised maintenance workflow

`web/src/app/catalogues/[id]/page.tsx` displays stored figures and export. `web/src/lib/plans.ts` advertises re-pricing, but no re-price/edit path was found. Saved rows trust browser-supplied calculated fields, preserve only a boolean scope flag, and omit dataset/rule versions. SKU limits apply to one save, not total stored/watched products; clarify whether that matches the commercial promise.

Fix: store validated inputs, complete server-produced result snapshots and revisions; implement re-pricing with comparisons and an explicit total-storage/watch policy. Do not treat user-supplied totals as authoritative calculations.

### 17. Medium — interface recovery and accessibility are incomplete

Source inspection: audit textarea and calculator inputs lack associated labels; the upload input is hidden inside a non-focusable label; audit state lives in component memory and signup redirects to account, losing task continuity. Calculator amount lacks decimal step, transport controls and shared engine credentials. API helper failures collapse into null, confusing outage with missing data. No route error/loading files were found.

Fix: label fields, make upload keyboard-operable, announce status/errors, preserve draft and return intent, distinguish unavailable/invalid/empty outcomes, and retain previous results on failed retries. Browser keyboard, screen-reader and responsive validation remains necessary.

### 18. Medium — tests pass copies of implementation rather than production behavior

`web/tests/billing.test.mjs` explicitly duplicates hashing/schema/SQL rather than importing the production modules; its plan test includes a nonexistent pro tier. Catalogue tests likewise exercise simplified fixtures. Consequently they pass despite webhook retry/order defects. `web/tests/email.test.mjs` defaults to the real local accounts DB and deletes `diff_state` in seed/cleanup.

Fix: import production logic or drive actual routes with injected dependencies; isolate every test database by construction; cover failure/retry/concurrency. Require explicit opt-in for any test that touches an existing database. Add CI with locked Python dependencies, lint/type checks and isolated integration suites. No Python dependency manifest or CI workflow was found in the inspected file listing; installation uses unpinned pip packages.

### 19. Medium — operational documentation and checks overstate readiness

`docs/STATUS.md` says accounts/billing/catalogues are not built, despite their implementation. Several comments still describe in-process limits although SQLite is used. `ops/install.sh` installs Python packages without versions and ignores preflight failure using `|| true`; fresh-host prerequisites such as pdftotext are not provisioned there. Health proves database access but not engine/reference consistency or useful ruling-index coverage.

Fix: update status from a single release checklist; pin runtime dependencies, verify prerequisites, distinguish installation from readiness, and add checks for edition/index/engine agreement, alert lag, failed delivery backlog and webhook backlog. Exercise backup restore against the actual production account-store mode.

## Architecture and design assessment

Keep the Python engine, separate reference/account stores and Next.js frontend. Separating reproducible public data from customer state is appropriate. Parameterized queries, account-scoped catalogue lookups, random sessions, password hashing, hashed reset tokens, raw-body Stripe signature verification and server-side engine credentials are useful foundations. Their presence is not a blanket security certification.

The brand reference has a coherent paper/forest/copper palette and a distinct editorial/data typography system. Preserve it. The main design gap is turning a results table into a review workflow: show description beside SKU, provide review filters, make evidence expandable, preserve failed rows, allow corrections and re-price. Explicit estimate/completeness states matter more than cosmetic polish. Fixed-size HTML design boards do not establish responsive behavior.

The existing `docs/FRONTEND-AUDIT.md` was present before this audit and was left intact. It is not entirely current: its CSV-export finding describes an earlier custom exporter, while the current AuditClient imports the shared `toCsv`. Revalidate older audit claims against current code before turning them into work items.

## Validation performed and limits

- Duty tests: 25/25 passed.
- Billing scratch tests: 10/10 passed; limited by duplicated logic.
- Catalogue scratch tests: 11/11 passed; limited by simplified fixtures.
- ESLint: zero errors, five warnings.
- TypeScript no-emit check: no diagnostics.
- Isolated Python reproductions: ruling-index loss, origin alias divergence, parser omissions, and invalid-code API success confirmed.
- Email integration tests: 0/10; all HTTP calls failed because no web server was running. This is an environment/setup failure, not ten confirmed product failures.
- Important audit side effect: that email test defaults to local `data/accounts.db`, seeds then cleans up its own accounts, and clears `diff_state` in both setup and cleanup. It was run before that behavior was identified. Any pre-existing local diff cursor was not captured and cannot be reconstructed from this audit. No further database-mutating integration tests were run.
- No production build, full browser journey, real Stripe/email delivery, load test, dependency vulnerability scan or complete tariff-law validation was performed.
- No application source was edited. Pre-existing tracked bytecode changes and the existing frontend audit were left intact.

## Recommended execution order

1. Correctness and data: fix snapshot refresh/index preservation, reject invalid codes/origins, model unsupported rates and entry-level fees, preserve all warnings/rows.
2. Reliability and abuse controls: repair webhook recovery/order, alert pagination/outbox, and public web cost limits.
3. Evidence: correct classifier evaluation, test real implementation paths, isolate integration data, automate release checks.
4. Product completion: saved revisions/re-pricing, review workspace, authentication continuity, accessible recovery states and consistent design components.

Release gate: a refreshed dataset must produce consistent versioned quotes; unsupported inputs must never look complete; failed billing/email work must recover; every imported row must remain accountable; and meaningful integration tests must prove those properties.
