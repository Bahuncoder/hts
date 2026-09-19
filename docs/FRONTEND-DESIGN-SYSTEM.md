# HTSDesk frontend design system

Implemented September 2026. This builds on `design/BrandSystem.dc.html` and `design/Audit.dc.html`, with responsive application components instead of fixed-size boards.

## Direction

A calm, practical import workspace. Warm paper backgrounds frame white work panels; forest green identifies primary actions and active navigation; copper is reserved for conditional recovery figures. Amber signals review and red signals failure. Always accompany color with a written status.

Use editorial serif headings for orientation, sans-serif body/control text for reading, and monospaced tabular figures for codes and money. Keep numbers precise in review tables. Decorative imagery is unnecessary for these workflows: the product's own examples, tables, and evidence explain its value.

## Shared primitives

| Primitive | Implementation | Use |
| --- | --- | --- |
| PageHeader | `web/src/components/PageHeader.tsx` | Small contextual label, clear task title, concise guidance, optional primary action |
| Card / panel | `web/src/components/ui.tsx`, `.panel` | Related content with one consistent border, surface, and 10px radius |
| Buttons | `.btn`, `.btn-primary`, `.btn-secondary` | 44px minimum height, 6px radius, proper disabled and keyboard-focus states |
| Fields | `web/src/components/Field.tsx`, `.field-control` | Persistent labels, examples in placeholders, associated helper text |
| Metrics | `Stat`, audit `.metric-card` | Tabular values, visible incomplete status, supporting context |
| Navigation | `SiteNav`, `.nav-item` | Active page marked with text weight, marker, and aria-current; collapsible below wide desktop |
| Tables | `.data-table` | Muted headers, aligned numeric columns, readable row spacing; overflow contained within a labeled keyboard-scrollable region |
| Workflow | `.workflow-steps` | Import → review → save, with a textual current step |

Semantic colors are defined once in `web/src/app/globals.css`, with light, system-dark and explicit-dark variants. Controls use `--on-accent` on green, never the paper token. Motion respects the reduced-motion preference. Default focus rings remain visible.

Spacing: use 16px between related controls, 20–28px panel padding, 24–32px between work sections, and larger separation only between landing-page sections. Page width is capped at 1280px, with 20px mobile and 32px larger-screen gutters.

## What changed

- Home: concise product introduction, an explicitly illustrative duty breakdown, three task cards, and a quieter evidence section.
- Shell: larger consistent gutters, active navigation, a compact menu for narrow screens, and a clearer primary action.
- Audit import: numbered workflow, titled panel, visible product ceiling, file/template/sample actions, consistent buttons, and a file-size check before loading its contents.
- Audit review: search by SKU/description/code/origin, sort by duty/value, existing status filters and pagination, descriptive empty state with reset, styled metrics/table, and accessible horizontal scrolling.
- Result integrity: shipping-assumption changes now mark the last result stale; stale results cannot be saved until recalculated. Code-detail links preserve the line's country of origin.
- Classify: consistent task heading/form, expandable full classification path, unclipped ruling subjects, and a direct Calculate action for each candidate.
- Calculator: shared introduction, grouped input panel, consistent fields and primary action; existing scenario controls remain intact.
- Catalogues: shared heading, primary audit action, purposeful first-use empty state, and consistent cards.
- Changes: concise introduction and a contained filter panel.
- Authentication and recovery: shared panel, fields and buttons; auth errors/notices receive alert/status semantics.

Existing functionality for row reconciliation, error preservation, signed saved results, audit assumptions and backend controls was retained. The concurrent move to free account limits was preserved; this work does not reintroduce paid plans.

## Next workflow enhancements

1. **Preserve an audit through authentication.** Add a short-lived draft with an explicit restore action and a safe return destination. Do not silently persist supplier data indefinitely or reuse one account's draft for another account.
2. **Edit and re-price a saved catalogue.** Show old/new calculation revisions and changed duties before replacing anything. This needs a backend snapshot/version workflow, not only a new button.
3. **Resolve review items in place.** Let users compare candidates and supply missing product facts, then recalculate. A changed code must update the signed result and provenance.
4. **Improve large-file intake.** Add column mapping and an editable preview, preserving original row identity and field-level feedback.
5. **Monitoring controls.** Bring last successful coverage, delivery failures and retryable states into the alerts workspace as the backend exposes them.
6. **Validate real-world accessibility and typography.** Complete screen-reader journeys, zoom checks and measured contrast across components; consider locally hosted font assets for predictable loading.

These are follow-on items, not UI capabilities implied to be available today.

## Verification

Use `node tests/ui-workspace.test.mjs` from `web/` for a production-build browser check. It uses the shared isolated test harness, new scratch account data, a fake engine and spare ports 3378/3379. Optional `HTSDESK_SHOTS` saves screenshots. It does not send real email or access real customer data.

Covered: primary home actions, illustrative-data labeling, product search and duty sorting, status filtering and row details, shipping-change stale state, recalculation recovery, 320/390/768/1440px page overflow, dark controls, active mobile navigation, labeled calculator/login controls and browser runtime errors. Font requests are blocked in this suite, so screenshots exercise fallback fonts rather than certifying remote font loading.

Validation during this change used an isolated copy of the frontend and an optimized Next.js webpack build, keeping active development output and databases untouched. No claim is made that this UI validation certifies tariff calculations or every backend workflow.

Final results: optimized production webpack build and its TypeScript check passed; focused UI suite 6/6, existing catalogue review suite 26/26, and unsigned-save check 1/1 passed. ESLint reports no errors and five existing unused-variable warnings in other tests. `git diff --check` passed. The browser checks verified both failed-run recovery and successful save/export behavior, not just screenshots.
