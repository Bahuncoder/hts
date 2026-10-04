# HTSDesk product and UX audit

Date: 2026-09-30. Scope: the current local frontend, source, browser-rendered pages, and representative workflows. Product code was not changed.

## Status as of 2026-10-04

This audit is a point-in-time record of 2026-09-30. The screenshots and
`observations.json` in `ux-audit-2026-09-30/` show the product as it was then,
and are kept as the baseline. The table below records what has since changed,
with the commit that changed it. "Partly" means the finding's core complaint is
addressed but a recommended element is not.

| ID | Status | Evidence |
|---|---|---|
| 01 Review queue beside a detail panel | Addressed | `2e586d0`: queue, status filter, search, pagination, decide-and-next, phone detail view |
| 02 Correction, recalculation, provenance | Addressed | `e778ba3`: draft then confirm, version-guarded, before/after history. Candidates come from the same classifier, so their quality is the 15.5% figure in `docs/STATUS.md` |
| 03 Search and sort persist; one interaction model | Partly | Saved catalogues keep search and sort in the URL (`e819e6b`). The audit page's client-side model is still separate from the server-side pages |
| 04 Saved catalogue leads with status | Addressed | `e819e6b`; costs collapsed; `e811939` moved audit totals below the products |
| 05 Pricing promise matches behaviour | Addressed | `e819e6b`: copy no longer promises feature parity |
| 06 Calculator: code discovery first | Addressed | `e819e6b` put search first; `791df87` collapsed quantity and programme |
| 07 Sign-in returns to the task | Addressed | `e819e6b`: validated `next` on nine pages, allowlist extended |
| 08 Confidence language and evidence strength | Partly | "Unconfirmed classification" label in place; no formal evidence-strength explanation |
| 09 Public and app navigation separated | Partly | `3ea0261`: two-path start on the homepage and a "Your work" panel. The header navigation is unchanged |
| 10 Spreadsheet intake with mapping and preview | Addressed | `c45683e`, `be54595`: column mapping, preview, outdated-result marking, draft survival. No cell editing in the preview |
| 11 Mobile product cards | Partly | `e811939`: cards for the review queue and saved lines. Other mobile screens still use the audit table |
| 12 Completeness and approval shown separately | Partly | Both axes are shown; the "Needs attention" wording is still used for both |
| 13 Alerts tied to affected products | Open | Alerts list watched codes with their catalogue name, but do not say which saved products a change affects |
| 14 Refund checks in main navigation | Open | Not in the site navigation |
| 15 Returning user lands on work | Partly | `3ea0261`: "Your work" panel on the account page; default landing unchanged |
| 16 Answer, limitation, next action order | Partly | `e811939` and `791df87` reduced the working screens; content order elsewhere unchanged |
| 17 Old and new results compared per product | Open | Reprice writes a history note; there is no per-product before/after view |
| 18 Assignment is clearly a label | Partly | Copy says a name or email, with no login; no invitations or permissions |
| 19 Product instrumentation | Open | No product analytics; the privacy page promises none |
| 20 Consistent component styling | Partly | The undefined `paper-card` class was removed; a full consolidation of buttons, panels and badges is not done |

## Verdict

HTSDesk has a credible visual identity and substantial working functionality. It currently feels like a collection of specialist tools with an emerging workspace, rather than a fully integrated daily operating product. Its visual maturity is ahead of its workflow maturity.

The main barrier to the quality associated with a mature product company is the amount of interpretation, navigation, and manual coordination left to the user. A new visual theme alone will not fix this. Keep the green, warm neutrals, restrained surfaces, and readable financial figures. Invest first in review completion, information hierarchy, continuity, and large-catalogue usability.

Heuristic ratings, not usability-study results: visual identity 7/10; information architecture 5/10; onboarding 5/10; repeat-work efficiency 4/10; mobile task experience 4/10; content hierarchy 5/10. The product is a credible beta foundation. This is not a production-readiness certification.

## Evidence and limits

I inspected home, classification, calculator, initial and completed audits, HTS detail, pricing, authentication, account, alerts, refund intake, saved catalogues, review and evidence/report code. Screenshots include desktop, mobile, and dark appearances. The browser uses the real production frontend with isolated test accounts and simulated engine responses. Example rates and totals in screenshots are fixture values, not validated current tariff results.

Checks run:

- `node tests/ui-workspace.test.mjs`: 10/10 passed.
- `node tests/contrast.test.mjs`: 11/11 passed; 52 page-state/theme sweeps, 3,400 text measurements, lowest reported contrast 4.95:1.
- `node tests/feature-journey.test.mjs`: passed audit, FX costs, save, reopen/edit costs, export, approval, assignment/history, PDF, mobile containment, and account isolation.
- Additional 100-product browser inspection: saved view had zero search inputs; review rendered 100 rows without pagination or search; selected decision control was at document y=5,723 CSS pixels at desktop size. The saved mobile table measured 820 pixels wide in a 390-pixel viewport.
- Signed-out `/refund-check` redirected to `/login` without a return destination.

The extra inspection initially hit a browser-script navigation race; after explicitly waiting for route changes, it completed. That initial script failure is not a product defect.

This audit did not validate current legal/tariff facts, live classifier accuracy, payment-provider operation, real email delivery, production performance, screen-reader completion, Safari behavior, or actual customer conversion. Existing code and internal documents do not establish customer demand. Screenshots and raw layout observations are in [the evidence directory](ux-audit-2026-09-30/).

## Strengths worth preserving

1. The visual identity is coherent: deep green, warm background, restrained borders, editorial headings, and monospaced financial figures.
2. Core features are real: importing, reconciliation, saved evidence, cost allocation, human decisions, repricing, reports and monitoring are implemented.
3. The interface makes incomplete estimates visible. This is a product strength; retain it while making next steps clearer.
4. Initial audits already have search, sorting, status filters, expandable evidence, row identity, and a collapsed import panel after calculation.
5. There is real attention to recovery: draft preservation around audit authentication, stale-result protection, error messages, loading states, and review conflict protection.
6. Accessibility foundations include explicit labels, focus styles, skip navigation, non-color status cues, reduced-motion support, and measured contrast.
7. Human decisions and engine calculation states are represented separately, which is the right underlying distinction.

## Prioritized findings

P1 means fix before presenting the affected workflow as polished or making it central to paid adoption. P2 means the next substantial usability improvement. P3 means refinement. Effort is relative, not a delivery estimate.

| ID | Priority | Evidence / user problem | Recommended change | Effort |
|---|---|---|---|---|
| 01 | P1 | Review form follows every product row; 100-product decision field is 5,723px down the document. | Searchable review queue beside a persistent detail panel; focused detail screen on phones; next unresolved item. | M |
| 02 | P1 | Review records approve/request changes/reject, assignment and comments, but does not provide a complete correction flow for HTS, quantity, origin and missing facts. | Edit facts, compare candidates, recalculate, show before/after, then record the decision with provenance. | L |
| 03 | P1 | Search and sort exist in the initial audit but disappear after saving; dedicated review lists all rows. | Reuse one product-list interaction model across audit, saved catalogue and review; preserve filters, sort and position. | M |
| 04 | P1 | Saved catalogue renders expanded landed-cost fields before review summary, totals and products. | Place status and primary action first, then products; move costs, evidence and history into secondary views. | S–M |
| 05 | P1 | Pricing promises scale-only differences while API and refund checks are paid-only. | Rewrite promise and compare entitlements explicitly; explain usage units and limits. | S |
| 06 | P1 | Calculator help for users who do not know their HTS code comes after the large code-dependent form. | Start with “I know my code / Help me find it”; carry description and product context forward. | M |
| 07 | P1 | Refund sign-in loses destination; return allowlist also lacks calculator, classify and nested catalogue/review paths. | Support validated internal return routes and necessary scenario context; test links from email, pricing and saved work. | M |
| 08 | P1 | Generic confidence labels coexist with an internal evaluation describing candidate retrieval, not established exact-code accuracy. | Explain evidence strength and missing facts; require review; measure before claiming stronger automation. | M–L |
| 09 | P2 | Navigation gives tools and saved-work destinations equal rank; no task-oriented signed-in home. | Separate public navigation and app navigation; add overview, catalogues, review queue, monitoring, refund checks and tools. | M |
| 10 | P2 | CSV text area and a long format paragraph dominate first use. | Upload/paste spreadsheet, map columns, preview interpreted rows, repair cells, then run. Keep raw CSV as an advanced option. | L |
| 11 | P2 | Mobile pages stack many sections; product tables remain wider than the screen. | Compact summaries and mobile product cards with status, money and one clear action; dedicated detail screen. | M |
| 12 | P2 | “Ready,” “Needs attention,” “Needs review,” “Scope review,” and human approval require interpretation. | Display two explicit axes: calculation completeness and human review. Give each blocker an action. | M |
| 13 | P2 | Alerts primarily expose matched notices and code links, not impact on saved goods. | Group by affected catalogue/product, show effective date and recommended review/reprice action; preserve matching-coverage limitations. | M–L |
| 14 | P2 | Refund checks are discoverable through pricing/account and some content, but absent from main signed-in navigation. | Give historical-entry work a clear navigation destination and explain what data it needs before gating. | S–M |
| 15 | P2 | Default auth destination is Account, dominated by plan allowances and settings. | Land new users on a guided first task and returning users on work needing attention. | M |
| 16 | P2 | Benefits and technical detail compete: raw source counts, acronyms, scope language, and repeated cautions. | Organize content as answer → limitation → next action → evidence; keep technical depth on demand. | M |
| 17 | P2 | Repricing communicates a changed count but lacks a first-class visual comparison of old and new results. | Show per-product deltas, reasons, revision date and review changes; preserve historical evidence. | M–L |
| 18 | P2 | Assignment accepts a name/email, while actual team seats are still listed as unbuilt. | Clarify that assignment records a label; implement invitations, permissions and notifications before promising collaboration. | S for copy / L for teams |
| 19 | P2 | No frontend product-event instrumentation found; privacy page explicitly promises no analytics trackers. | Begin with moderated task studies; add minimal aggregate operational/task metrics only with an intentional privacy design and matching copy. | M |
| 20 | P3 | Styling components drift: custom account/alerts controls, inconsistent table styling, undefined `paper-card` class in saved costs. | Consolidate buttons, panels, tables, headings, statuses and empty states into shared patterns. | M |

### 01–04: The critical review and saved-work loop

A user should be able to answer: Which product needs me? What is missing? What do I change? Did that resolve it? What changed in the estimate?

Today, the user can see warnings and record a human opinion, but the interface does not consistently carry them through resolving the underlying calculation. Approval must not simply hide an engine warning. Keep both states, and let the user supply the information that changes the calculation.

The review page is the most important redesign. Use a queue filtered to unresolved or pending products, a selected-product panel with facts/evidence, explicit correction actions, and an “Approve and next” action when eligible. On phones, open the selected item as a full screen with a clear way back to the same queue position.

The saved catalogue should feel like the continuation of the audit. Currently, it becomes a different interface and opens with shipment-cost editing. Put a compact summary and “Review N products” first. Use tabs or sections for Products, Costs, Evidence, and Activity. Keep import-cost controls collapsed unless the user deliberately opens them.

Acceptance: at 100 and 1,000 products, a selected product's decision control appears without scrolling through unrelated products; search and sort persist across save/reopen; user can correct an incomplete line without rebuilding the whole CSV; repricing preserves a traceable before/after record.

### 05 and 08: Trust depends on matching promises to behavior

The pricing contradiction is concrete and inexpensive to fix. “Plans for your import workload” would avoid promising feature equality. Show which capabilities and quotas belong to each tier. Replace “Most catalogues” with a descriptive fit label unless actual adoption evidence supports it. The local unconfigured billing message mentions Stripe keys: keep configuration details in operational diagnostics; show a plain availability message to customers. This observation does not establish whether production billing is configured.

The audit page metadata promises annual exposure, but the intake models submitted values and entries without an explicit annualization workflow. Align metadata with what the user can actually calculate.

The recorded 2026-09-24 evaluation in `docs/STATUS.md` reports 15.5% top-1 exact 10-digit accuracy for a 400-case held-out, retrieval-only evaluation. This was not rerun during this audit. It is not a measurement of every user query, a reasoning-enabled model, or the duty engine's accuracy. It does support positioning the classifier as evidence-backed candidate research, as the document itself states.

“High confidence” should not be read as a validated probability. Describe what the supporting evidence establishes and ask the product-specific questions needed to distinguish candidates. The public title “Find the right HTS code” is stronger than “Compare candidate HTS codes.”

### 06–07: Eliminate avoidable interruptions

The calculator's code-discovery path is below the form requiring the code. Reverse that dependency. Ask for a known HTS code or a product description first, then origin and value. Show quantity when the applicable duty needs it. Put special program and product-use conditions in contextual follow-ups, while keeping relevant shipment assumptions visible.

Defaulting entered value to 10,000 risks an untouched example becoming a real estimate. Prefer a blank required field or an explicitly selected sample mode. Preserve product description, origin and assumptions when moving between classification and calculation.

The audit draft handoff is already thoughtfully implemented. Extend that continuity to refund checks and deep catalogue links. Do not relax redirect security; expand the validated route model.

### 09 and 15: Arrange around the user's work

Proposed public navigation: Product, How it works, Pricing, Resources; Sign in and Try a sample.

Proposed signed-in navigation:

- Overview: recent work, unresolved items, monitoring status, and next action.
- Catalogues: durable product lists and their calculations.
- Review queue: decisions across catalogues.
- Monitoring: watched products and relevant changes, with the general feed secondary.
- Refund checks: entries already filed, clearly separate from future-entry estimates.
- Tools: standalone classification and duty calculation.
- Account/help in secondary navigation.

Do not make every feature a permanent top-level item as the product grows. “Catalogue audit” is an action on a catalogue, not a peer information category that always needs a separate place beside “Catalogues.”

For the core audience, the recommended product promise is: “Review your import catalogue, understand duty exposure, and keep evidence for decisions.” Classification, calculation, reporting and monitoring support that job. Validate this emphasis with actual importers before reorganizing every screen.

### 10–12: Make complexity manageable

The existing template, sample, row errors and assumptions are good foundations. The missing import layer is translation from the user's spreadsheet into the product's schema. Provide a preview with mapped columns, currency/unit interpretation, invalid cells and preserved source-row identity. Avoid forcing users to learn CSV syntax.

Replace repeated generic warning blocks with one summary and targeted row actions. An unresolved-scope notice should say what information is needed or who should review it. Keep the precise source and authority available underneath. No upper-bound range should be invented when the system cannot calculate one.

On phones, prioritize reviewing an alert or one product, checking status, and making a decision. Horizontal table scrolling is not automatically a WCAG failure—tables have an exception—but it is still a poor default for frequent single-product tasks. Screenshots show this problem in both audit and saved views.

### 13–14 and 17–19: Make returning worthwhile

Monitoring already exposes the last successful check and delivery failures, which should be retained. Add a clear path from an alert to the affected saved work, then to a recalculation or review. Do not imply that matching explicit HTS mentions detects all applicable legal changes.

Historical entry checks should have their own explanation and saved history. “Potentially refundable” should keep its qualification even in compact list summaries, where the current “Refundable” label is stronger than the detailed copy.

The team and approval model needs product clarity: recording an assignee name is not the same as giving that person access or notifying them. This matters particularly when the pricing emphasizes large import programs.

No need to add many new features before measuring the core workflow. Run observed sessions with new users and experienced importers; include messy spreadsheets and incomplete lines. Measure first successful estimate, successful first save, completion of one correction, ability to find a changed product, and successful broker handoff. Track time and errors, not just clicks.

## Visual and content direction

Keep the identity. Tighten the operational screens.

- Use editorial serif type prominently on public pages, with smaller operational page titles inside the workspace.
- Use roughly 14–16px for working text; reserve the current tiny uppercase mono labels for secondary metadata.
- Reduce repeated eyebrow/title/description/divider blocks inside a single workflow.
- Put a single primary task action in each view. Group export variants under Export, labeled by destination and format.
- Keep money aligned and incomplete totals visibly qualified. Avoid giving hypothetical recovery equal emphasis to the current work unless recovery is the chosen task.
- Use consistent page widths, table density, controls, semantic status colors and spacing. Do not add decorative charts with no decision purpose.
- Use direct headings: “Estimate import duty,” “34 products need review,” “Review tariff changes.” Prefer those to general headings such as “Review the details.”

Example issue copy, with numbers treated as placeholders rather than claims:

> 3 products need information. Duty for the priced products is $X. This is a partial estimate. Review missing information.

Example status vocabulary:

| Dimension | Suggested values |
|---|---|
| Calculation | Complete estimate; Needs information; Could not calculate |
| Human review | Not reviewed; Approved; Changes requested; Rejected |
| Monitoring | Last checked [time]; Check delayed; No matching notices |

## What “Google-level” quality means here

No one can say what Google would build for this particular market, and copying Google's visual language is not an assurance of good UX. The useful benchmark is consistent interactions, clear content, efficient frequent tasks, accessible behavior, recoverable errors, and validated outcomes.

Google's Material guidance explicitly includes accessibility, layout, interaction and content design in its foundations. Its UX-writing guidance emphasizes helping users complete tasks with clear, concise text. That supports prioritizing task flow over a purely cosmetic redesign.

References: [Material foundations](https://m3.material.io/foundations/), [Google's communication guidance](https://codelabs.developers.google.com/codelabs/material-communication-guidance), [W3C reflow guidance](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html), [W3C target-size guidance](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html).

The contrast suite is valuable but is not full accessibility certification. Next checks should include keyboard-only complete workflows, focus after route changes, screen-reader decision and error announcements, 200–400% zoom, and mobile target sizing. Do not report generic accessibility failures without measuring them.

## Delivery order and acceptance gates

### First: fix trust and immediate friction

Correct pricing/metadata promises; retain refund intent through sign-in; make code discovery available before the calculator; reduce saved-page cost prominence; make row review visible without passing every row; carry over audit search and sort.

Gate: a new visitor understands free versus paid capabilities, can find a code without hunting below the form, can sign in and return to their task, and can find and open a product in a saved 100-row catalogue.

### Second: complete the working loop

Build the queue/detail review model and correction/recalculation path. Preserve selection and view state. Show estimate changes and keep provenance. Add spreadsheet mapping and row repair.

Gate: an importer can import, correct one problematic product, recalculate, record a decision, save and export without recreating their catalogue or losing context.

### Third: improve repeated use and mobile

Add the signed-in overview, clear feature grouping, contextual monitoring actions and focused mobile product review. Clarify assignment behavior. Consolidate the remaining design-system inconsistencies.

Gate: a returning user can identify what needs attention and act on it; a mobile user can review a single affected product without horizontal hunting through a desktop table.

### Fourth: validate and tune

Observe 5–8 target users initially as a formative study, not a statistically representative benchmark. Give them realistic tasks without coaching. Use findings to prioritize; do not set conversion improvements as achieved without a baseline. Benchmark larger catalogues and real engine latency separately from fixture-based frontend checks.

Proposed usability goals: users explain the product's purpose after viewing the landing page; discover a first action without assistance; complete one import/correction/export workflow; distinguish incomplete calculations from human approval; find saved work and explain monitoring coverage. Record completion, time, errors and comprehension before assigning numerical targets.

## Primary implementation evidence

- `web/src/app/page.tsx`: public promise, competing CTAs, illustrative result and source counts.
- `web/src/app/layout.tsx`, `components/SiteNav.tsx`: shared public/app navigation.
- `web/src/app/calculator/page.tsx`: long input form, default value and subsequent code search.
- `web/src/app/audit/AuditClient.tsx`, `AuditResults.tsx`: import, draft, results and initial search/sort.
- `web/src/app/catalogues/[id]/page.tsx`: costs before results and saved-list controls.
- `web/src/app/catalogues/[id]/review/page.tsx`: unpaginated rows followed by decision form.
- `web/src/components/SavedCosts.tsx`: always-expanded cost editor and undefined panel class.
- `web/src/app/pricing/page.tsx`, `web/src/lib/plans.ts`: inconsistent pricing promise and entitlements.
- `web/src/lib/next.ts`, `web/src/app/refund-check/page.tsx`: limited return destinations and lost refund context.
- `web/src/app/alerts/page.tsx`: matching scope, monitoring health and notice-centric presentation.
- `docs/STATUS.md`: dated, limited classifier evaluation; do not treat it as a new measurement.
