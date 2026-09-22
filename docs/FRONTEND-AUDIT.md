# HTSDesk frontend audit — 17 September 2026

The frontend has a credible visual foundation and broad feature coverage. The highest-value work is making import, review, recovery, and saved-catalogue workflows trustworthy. Preserve the existing brand and improve the interaction model before adding decorative polish.

## Scope and confidence

Reviewed the shared shell, CSS tokens, shared components, landing, audit, calculator, classifier, HTS detail, catalogues, alerts, pricing, account, authentication, API client, and supporting actions. Compared the audit implementation with `design/Audit.dc.html`.

- Source findings below are confirmed against the files inspected; product/design proposals are recommendations.
- Reproduced CSV row omission and formula export using the actual frontend functions in an isolated Node harness. Two input rows, one with an invalid amount, produced one submitted row. A harmless SKU `=1+1` was exported without neutralization.
- ESLint completed with zero errors and six warnings at the time of the check. This is not a typecheck or a successful production build.
- Attempted desktop/mobile Playwright checks against isolated localhost services. Home rendered on retry, but `/audit` returned HTTP 500 while concurrent edits were migrating `better-sqlite3` to `@libsql/client`. The error came through `diff.ts` and the server-action import graph. This is a transient workspace observation, not a conclusion about the final migration.
- Full browser, keyboard, screen-reader, responsive, contrast, performance, and dark-mode validation remain outstanding. No Lighthouse score or measured mobile pass is claimed.
- No application source was changed for this audit. Other application edits appeared concurrently and were left untouched. The audit used temporary runtime/account paths.
- Tariff law, refund eligibility, marketing statistics, and current tariff rates were not independently validated; recommendations concern their presentation and evidence.

## Prioritized findings

### F01 — High: invalid CSV rows silently disappear

Evidence: `web/src/app/audit/AuditClient.tsx:146` maps rows and filters out missing descriptions/countries and nonpositive or invalid numeric values before submission. A mixed-validity file produces no rejected-row feedback. The server only knows about the surviving rows.

Impact: an apparently completed catalogue audit can omit products and underrepresent exposure. `Number()` also rejects common currency-formatted values such as `$1,000` rather than giving an actionable field error.

Change: validate every row, preserve original row numbers, show accepted/rejected counts and reasons, detect missing/duplicate headers and malformed quoting, and require explicit acknowledgement before proceeding with a subset. Offer a template and column mapping. Check finite positive amounts and input/file limits before submitting.

Acceptance: a two-row file with one bad value reports “1 valid, 1 needs correction”; no row disappears. Currency formats are either explicitly supported or explained. Users can download rejected rows.

### F02 — High: audit download bypasses safe CSV handling

Evidence: `AuditClient.tsx:92` has its own quoting-only emitter. `web/src/lib/csv.ts` already provides formula neutralization, but this browser export does not use it. Reproduced output contained `"=1+1"`.

Impact: supplier-controlled SKU/description text can be interpreted as formulas by spreadsheet software. Quoting CSV cells alone does not prevent this.

Change: use the shared safe emitter for both audit and saved-catalogue downloads, preserving legitimate numeric values. Test the actual browser download path as well as the helper.

Acceptance: formula-like SKU/description values are inert in every export path; ordinary monetary values remain numeric where intended.

### F03 — High: review totals do not represent all unresolved work

Evidence: `AuditClient.tsx:264` sums `needs_scope_review + unclassified`. The API also produces low-confidence classifications and pricing-error lines; neither is fully represented by that sum. `summary.items` counts returned lines, including errors, while truncated copy calls them priced. Saving at `AuditClient.tsx:367` removes error lines. The saved-catalogue review total counts scope flags only.

Impact: unresolved products can be missing from the review count and disappear from the saved work queue. A green-looking summary does not establish that the catalogue is complete.

Change: define shared row states: ready, low confidence, scope review, invalid input, pricing failed, not processed. Count the union of unresolved rows, not the sum of overlapping categories. Separate submitted, processed, successfully priced, and unresolved counts. Persist unresolved rows and original inputs.

Acceptance: a mixed fixture has reconciled counts across summary, filters, table, save, reopen, and export. Partial totals are visibly marked next to the amount.

### F04 — High: signup loses the task and selected plan

Evidence: audit input/results exist only in React state; the save CTA navigates to `/signup`. Authentication redirects to `/account`. `BillingButtons.tsx:57` sends `?plan=...`, but the inspected signup page only reads `verify` and does not preserve plan intent.

Impact: a user who has already completed an audit must start again after creating an account. A prospective subscriber loses the plan they chose.

Change: persist a short-lived draft and an allowlisted return destination; restore the audit after login/verification. Carry the selected plan through authentication and return to a plan confirmation or checkout action. Clear temporary drafts after save/expiry and account changes.

Acceptance: anonymous audit → signup/verification → original audit result → save works without re-uploading. Paid-plan selection survives the same flow.

### F05 — High: outage, empty, and invalid-input states are conflated

Evidence: `web/src/lib/api.ts` returns `null` for non-OK responses and network errors. Calculator reports “No result for that code”; classify can show no feedback; HTS detail calls `notFound()`; changes instructs the customer to run the poller. Home falls back to zero dataset counts when health detail is unavailable.

Impact: valid codes appear invalid, unavailable data appears absent, and operational failures look like user mistakes or empty datasets.

Change: return typed outcomes for success, empty, invalid, rate-limited, unavailable, and unexpected failure. Provide contextual retry while preserving input. Only real missing codes should become 404s. Display unavailable counts as unavailable, not zero. Keep operator instructions out of customer UI.

Acceptance: 400/422, 404, 429, 500, timeout, and empty-success fixtures each produce the correct state. Rate-limit feedback can use Retry-After.

### F06 — High: calculator hides assumptions and lacks essential input semantics

Evidence: `calculator/page.tsx:18` submits only HTS, country, and value; API quote supports `by_vessel` and `fta_claimed`, defaulting to vessel and no FTA claim. Inputs lack persistent labels. Amount has `min=1` but no decimal step. Search is a separate GET form, so submitting it drops selected country/value. Quote fetch also omits the shared `engineHeaders()`.

Impact: users cannot express air transport or an applicable claim through this page; decimal amounts can fail native validation; search resets their scenario. Shared anonymous limits can affect calculator traffic despite configured engine credentials.

Change: labeled HTS, country-of-origin selector, USD amount with cent precision, transport and explicit claim controls, and visible calculation assumptions. Preserve scenario parameters during search. Use the shared authenticated API transport. Label value-plus-duty precisely instead of implying freight/insurance/brokerage are included in landed cost.

Acceptance: air/sea selection reaches the API, cents submit correctly, country/value survive code search, and errors explain recovery. Do not invent FTA eligibility automatically.

### F07 — High: core form accessibility is incomplete

Evidence: audit textarea, calculator fields, and classifier input lack associated persistent labels. The upload input uses `display:none` inside a non-focusable label. Dynamic errors/results use ordinary paragraphs without live-status semantics. The shell has no skip link.

Change: shared labeled fields with helper/error associations; accessible keyboard-operable file upload; deliberate focus placement; `role="status"` for progress/success and appropriate alert semantics for errors; a skip-to-main link. Add consistent visible keyboard focus without removing browser defaults.

Acceptance: complete import, classify, calculate, authenticate, and save using keyboard only; errors and completion are announced without announcing the whole results table. Test with a screen reader. Guidance: [WAI forms](https://www.w3.org/WAI/tutorials/forms/) and [status messages](https://www.w3.org/WAI/WCAG21/Understanding/status-messages/).

### F08 — Medium: audit results are a readout, not a review workspace

Evidence: the live audit table omits description, has no review filter, search, sort, or expandable explanation, and ignores API-provided `suggested` candidates. It renders all rows. The design reference already includes Description and stronger summary emphasis.

Change: show SKU + description, HTS, origin, value, duty, and textual review status. Add All / Needs review / Ready / Failed filters, product search, sortable amounts, sticky headers, and row details with candidate codes, precedent, assumptions, and warnings. Use pagination first; consider virtualization only if measurement warrants it. Choosing a different classification must recalculate and persist provenance, not merely change a label.

Acceptance: a 1,000-product catalogue can be triaged without reading every row. Unresolved counts match visible filters. A user can identify a product with no SKU.

### F09 — Medium: saved catalogues have no maintenance workflow

Evidence: catalogue detail presents a snapshot and export; there is no edit, rename, re-price, or version-comparison action. Pricing advertises catalogues users can re-price. Delete submits immediately and removes catalogue-associated watches.

Change: expose original calculation time/data revision; add rename, edit and re-price actions with a before/after comparison. Confirm deletion with its monitoring consequences or provide a reliable undo. Catch save exceptions and reset pending state with `finally`; the current inline save handler only handles returned errors.

Acceptance: network failure cannot leave Save permanently busy. Deletion is recoverable or explicitly confirmed. Re-pricing does not overwrite a previous snapshot silently.

### F10 — Medium: monitoring language overstates empty-state certainty

Evidence: alerts says “Nothing has moved under your codes” whenever watched codes exist but no alerts do, including before any diff run. HTS detail promises email without checking plan eligibility/provider state. Alert list is capped at 100 without pagination; Mark read acts on the entire unread set.

Change: separate monitoring not started, current with no matches, stale/failed check, and matches found. Show “last successfully checked” and coverage limitations. Match email messaging to entitlements. Add readable filters/pagination and clearly scoped read actions.

Acceptance: an account before the first job sees “Monitoring has not run yet,” not reassurance. Users can reach all alerts, and understand what Mark read changes.

### F11 — Medium: loading and recovery patterns are missing

Evidence: no route `loading.tsx` or `error.tsx` files in the inspected app tree. Audit changes button text but gives no stage/count or meaningful long-running explanation; running again immediately clears the previous result.

Change: add route loading/error boundaries using the installed Next version's conventions. For audit, show real stages and elapsed time; do not fabricate percentage progress when the API does not provide it. Retain the last successful result until replacement succeeds. Explain partial execution and offer retry of unresolved rows.

Acceptance: slow/down services provide immediate understandable feedback, an available retry, and intact input. See [Next production guidance](https://nextjs.org/docs/app/guides/production-checklist).

### F12 — Medium: navigation does not establish location or mobile hierarchy

Evidence: the shared header wraps five public links plus authenticated links and account controls. It has no active-route treatment or `aria-current`. Mobile uses the same wrapping collection of links. No browser claim about exact header height is made.

Change: distinguish marketing navigation from the signed-in workspace. Use an active route, a compact accessible mobile menu, and a prominent primary task. Group operational pages around Catalogues, Classify, Calculate, Changes/Alerts. Keep pricing/account reachable without making them equal to every workflow step.

Acceptance: at 320, 390, 768, and 1440 pixels, keyboard order is predictable, the current page is identified, and the primary task is easy to locate. Test 200% zoom and long catalogue names.

### F13 — Medium: visual tokens exist but components apply them inconsistently

Evidence: `globals.css` defines `.mono` with tabular numerals, but 23 class attributes use `tabular`, which has no definition in the source CSS and is not the usual `tabular-nums` utility. Older pages have rounded cards/sans headings; pricing/accounts use square controls/serif headings. Recovery values are neutral or caution-colored despite the copper recovery token. Some primary buttons use `text-paper`, others `text-on-accent`.

Change: standardize Button, Field, PageHeader, Metric, Status, DataTable, EmptyState, and ErrorState. Use explicit `tabular-nums` or `.mono`, semantic foreground/background pairs, and a documented spacing/radius scale. Reserve copper for potential recovery, amber for review, green for confirmed/primary states. Text labels must carry the meaning as well as color.

Acceptance: the same action/state looks the same across audit, calculator, catalogue and pricing. Verify light/dark color pairs and focus contrast; no unmeasured contrast failure is asserted here.

### F14 — Medium: results need clearer evidence, freshness, and next actions

Evidence: primary totals appear before warnings; scope exclusions are not summarized alongside totals. Candidate cards link to code details but lack a direct scenario-preserving Calculate action. Ruling/path text is clamped without a way to expand it. HTS pages suggest choosing a child line without rendering a child-code picker.

Change: put estimate/completeness status and assumptions adjacent to the money; show data edition and last calculation time. Add Calculate this code and Review classification actions, expandable precedent, and heading-to-child navigation. Present potential recovery as conditional and distinguish it from current duty.

Acceptance: users can explain what a number includes, what remains unresolved, and their next action without reading the footer. Full evidence remains reachable on mobile.

### F15 — Medium: pricing and checkout messaging need reconciliation

Evidence: pricing metadata still names a $1,999 tier absent from the rendered plans. “$3,847” average and “MOST IMPORTERS” have no supporting source in the inspected page. Billing-unavailable copy mentions Stripe keys while purchase buttons remain actionable. Account page says “Payment received” solely from `?checkout=done`, ahead of verified subscription confirmation.

Change: generate metadata from actual plans; substantiate or remove numerical/social-proof claims; show customer-facing availability and a meaningful CTA. Distinguish checkout return, confirmation pending, and verified active subscription, with bounded refresh/polling and recovery. This is a presentation defect, not evidence of bypassed entitlements.

Acceptance: changing a plan updates cards and metadata together. A query parameter alone never claims confirmed payment. Disabled billing cannot lead into an avoidable failed purchase flow.

### F16 — Medium: discovery feeds hide useful information

Evidence: changes shows the first 14 HTS mentions and a noninteractive “+N more”; there are no visible filters or pagination. Country choices on code pages cover eight origins with no full selector.

Change: expandable mention lists, date/code/document filters, stable pagination, and complete searchable country selection. Preserve filters in URLs. Distinguish country of origin from shipping origin in helper text.

Acceptance: every displayed “more” control opens the remaining information; users can find an older action and select an origin beyond the initial eight.

### F17 — Medium: marketing home shows infrastructure before product value

Evidence: home leads from a long introductory paragraph into parser/data counts and technical explanations. The audit reference presents the financial/review outcome more concretely.

Change: retain the editorial brand, shorten the hero, show a clearly labeled example duty breakdown and review flag, then explain the three-step workflow and sources. Make Try a sample a deliberate action; the audit currently starts prefilled with sample CSV, which can be mistaken for the user's working data.

Acceptance: a first-time visitor can identify the product, the required input, the output, and the first action without understanding Chapter 99 parsing.

### F18 — Lower priority: font loading and performance require measured follow-up

Evidence: root layout loads three Google font families through an external stylesheet. Server components are already used broadly, which is a useful foundation. No real-user performance measurements were found in the reviewed frontend.

Change: use self-hosted/local fonts through `next/font` where appropriate, reduce weights, and establish production measurements before optimizing further. Prefer `Link` for ordinary in-app navigation where useful; preserve standard anchor behavior for downloads and external authorities. Inspect large-table DOM cost before adding dependencies.

Acceptance: assess LCP, INP, CLS and route response time on a production build with realistic network/CPU conditions. Do not treat development timings as production evidence. [Next font guidance](https://nextjs.org/docs/app/getting-started/fonts).

## Recommended audit interaction

1. Import: Upload CSV, Paste data, Download template, and explicit Try sample. Explain required columns and plan limit.
2. Validate: preview mapped columns, retain row numbers, reconcile valid/invalid counts, and resolve or explicitly exclude errors.
3. Run: preserve inputs and prior results, show honest activity, and explain partial processing.
4. Review: four metrics with estimate status; actionable review filters; SKU and description together; a details drawer or expanded row with evidence.
5. Save and monitor: preserve intent through authentication, retain unresolved rows, save the calculation version, and describe in-app/email availability accurately.

Desktop: restrained full-width work table, sticky header, optional evidence side panel. Mobile: concise product rows with expandable details or a deliberate scroll region with a visible cue; avoid shrinking every column until it is unreadable. The 1440px fixed-width design reference is a visual starting point, not a responsive implementation specification.

## Implementation order

| Batch | Scope | Exit condition |
|---|---|---|
| 1 — Trust and recovery | F01–F07; failed save handling; payment confirmation language | No silently lost rows, safe exports, preserved task intent, accurate states and keyboard-operable forms |
| 2 — Core workspace | F08–F12, F14 | Users can import, review, correct, save, reopen, re-price and monitor a catalogue |
| 3 — Consistency and conversion | F13, F15–F18 | Consistent components, supported copy, clear discovery, measured responsive/performance quality |

Complete the concurrent database migration before treating browser/build results as release evidence. Preserve the existing Next/React/Tailwind stack; no framework rewrite is justified by these findings.

## Focused regression coverage

- Mixed CSV validity; duplicate/missing headers; quoting, BOM and nonfinite amounts; explicit subset confirmation.
- Browser-downloaded CSV formula neutralization, including descriptions and SKUs.
- Low-confidence, unscoped, pricing-error and unprocessed rows across summary/save/export.
- Authentication/verification round trip preserves audit draft, return destination and selected plan.
- Calculator cents, transport, origin, claim controls and search-state preservation.
- API empty/invalid/rate-limited/unavailable states; stale monitoring and missing health detail.
- Keyboard upload and review, screen-reader errors/completion, 200% zoom, light/dark and 320–1440px layouts.
- Production build and meaningful browser journeys after migration; no real billing or external email is required for UI state fixtures.
