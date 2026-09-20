# HTSDesk frontend design system

Implemented September 2026. This builds on `design/BrandSystem.dc.html` and `design/Audit.dc.html`, with responsive application components instead of fixed-size boards.

## Direction

A calm, practical import workspace. Warm paper backgrounds frame white work panels; forest green identifies primary actions and active navigation; copper is reserved for conditional recovery figures. Olive-amber signals review and incomplete figures and red signals failure. Always accompany color with a written status.

### Colour roles

Copper and caution are deliberately different hue families, so a warning is never read as money to recover. Every text pair is at least 4.5:1 (3:1 for large text) on every surface it is used on, in light, system-dark and explicit-dark; `tests/contrast.test.mjs` measures the rendered pages.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--accent` | `#0d5142` | `#5fc0a5` | Primary actions, active navigation, what the product asserts |
| `--recover` | `#a8501f` (copper, hue ~21) | `#e08a4e` | ONLY refundable / recovery figures and the scenario-estimate label |
| `--caution`, `--caution-ink`, `--caution-soft` | `#786000`, `#5c4a00`, `#fbf5d9` (olive-amber, hue ~48) | `#e3c84a`, `#e3c84a`, `#2a2408` | Review, incomplete estimates (`Stat tone="warn"`, "Estimate is incomplete", `Note`, `PartialMark`), scope warnings |
| `--danger` | `#8f2f2a` | `#f28b82` | Failure, suspended, revoked |
| `--faint` | `#5d6b66` (>= 4.7:1 on paper, white, sunk, accent-soft) | `#7f9a92` | Small secondary text: labels, the footer and its legal disclaimer, placeholders |
| `--muted`, `--ink` | `#4d5b56`, `#161c1a` | `#9bada7`, `#e8efec` | Body and supporting text |

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

## Fonts

IBM Plex Sans (400/500/600), IBM Plex Mono (400/500/600) and Newsreader (variable, optical size) are loaded with `next/font/google` in the root layout. They are downloaded at build time and served from our own origin: a page view makes no request to Google, so no visitor address is passed to it and the privacy page has nothing to disclose about it. `display: swap`; the `--sans`, `--mono` and `--serif` tokens in `globals.css` read the `next/font` variables and keep system fallbacks. `tests/ui-workspace.test.mjs` records (does not block) requests during page loads and fails on any request to googleapis/gstatic.

## An audit survives sign-up

An anonymous visitor who runs an audit and then creates an account keeps their work, with a small, explicit privacy model (`web/src/lib/draft.ts`):

- **Client-side only.** One localStorage key, `htsdesk.draft.v1`, holding `{text, entries, transport, savedAt, rows}`. It is never sent to the server and never holds results or proofs (signed results expire and would be stale); only the catalogue text and the two assumption settings.
- **Expires after 24 hours**, checked and deleted on every read. Every storage access is wrapped in try/catch, so private windows, a full quota or disabled storage make the draft unavailable and change nothing else.
- **Written** when an anonymous visitor's audit succeeds and when they follow any sign-up/sign-in link from the audit page (header links included). Never for the sample, for empty text, or when signed in. The anonymous results say the catalogue is kept in this browser for 24 hours, with a "Forget it now" button (the privacy page says the same).
- **Restored only by choice.** Signed in on `/audit` with a valid draft, a panel offers **Restore it** or **Discard**. Restore fills the form and both settings and does not run the audit (running spends the allowance). `/account` shows the same notice with **Continue to audit**, which is how the email-verification flow (session created in another tab) finds its way back.
- **Deleted** after a restore, a discard, a successful save, and on sign-out (a client component on the sign-out form), so supplier data is not left for the next person on a shared computer.
- **`?next=`** on `/login` and `/signup` accepts only `/audit`, `/catalogues`, `/account`, `/alerts` and `/hts/<code>`; anything else is ignored, and the server action re-checks it (`web/src/lib/next.ts`). The header sign-in links carry the current allowlisted path. Verification tokens carry no `next`.

## What changed

- Home: concise product introduction, an explicitly illustrative duty breakdown, three task cards, and a quieter evidence section.
- Shell: larger consistent gutters, active navigation, a compact menu for narrow screens, and a clearer primary action.
- Audit import: numbered workflow, titled panel, visible product ceiling, file/template/sample actions, consistent buttons, and a file-size check before loading its contents. After a successful run the panel folds into a one-line summary ("N products · Edit catalogue") so results start above the fold; Edit reopens it (Run is in the panel), Collapse folds it back. The sample warning is shown once: in the panel before a run, on the results after it.
- Code page: a fragment line description ("Men's (338)") is replaced as the title by the nearest two ancestors from the path, keeping the line's own wording as a subtitle and the full path as a labelled breadcrumb; trade remedies that apply to the chosen origin come first and the rest are in a collapsed "Also cover this code for other origins (N)"; the three stat cards share a layout and incompleteness reasons sit under all three.
- Home: "Free while in beta" is a 14px pill beside the primary actions; the evidence block shows only figures the engine returned.
- Alerts: a status block with the last successful check and, per account, how many alert emails were abandoned after repeated failures (still listed).
- Audit review: search by SKU/description/code/origin, sort by duty/value, existing status filters and pagination, descriptive empty state with reset, styled metrics/table, and accessible horizontal scrolling.
- Result integrity: shipping-assumption changes now mark the last result stale; stale results cannot be saved until recalculated. Code-detail links preserve the line's country of origin.
- Classify: consistent task heading/form, expandable full classification path, unclipped ruling subjects, and a direct Calculate action for each candidate.
- Calculator: shared introduction, grouped input panel, consistent fields and primary action; existing scenario controls remain intact.
- Catalogues: shared heading, primary audit action, purposeful first-use empty state, and consistent cards.
- Changes: concise introduction and a contained filter panel.
- Authentication and recovery: shared panel, fields and buttons; auth errors/notices receive alert/status semantics.

Existing functionality for row reconciliation, error preservation, signed saved results, audit assumptions and backend controls was retained. The concurrent move to free account limits was preserved; this work does not reintroduce paid plans.

## Next workflow enhancements

1. ~~Preserve an audit through authentication~~ Done: see "An audit survives sign-up".
2. **Edit and re-price a saved catalogue.** Show old/new calculation revisions and changed duties before replacing anything. This needs a backend snapshot/version workflow, not only a new button.
3. **Resolve review items in place.** Let users compare candidates and supply missing product facts, then recalculate. A changed code must update the signed result and provenance.
4. **Improve large-file intake.** Add column mapping and an editable preview, preserving original row identity and field-level feedback.
5. **Monitoring controls.** Last successful check and abandoned-email counts are shown; retryable states and per-alert delivery detail are not.
6. **Validate real-world accessibility.** Contrast is measured and fonts are self-hosted; complete screen-reader journeys and zoom checks remain.

These are follow-on items, not UI capabilities implied to be available today.

## Verification

Use `node tests/ui-workspace.test.mjs` from `web/` for a production-build browser check. It uses the shared isolated test harness, new scratch account data, a fake engine and spare ports 3378/3379. Optional `HTSDESK_SHOTS` saves screenshots. It does not send real email or access real customer data.

Covered: primary home actions, the beta pill, illustrative-data labeling, the evidence block with and without counts, product search and duty sorting, status filtering and row details, the folded import summary, shipping-change stale state, recalculation recovery, 320/390/768/1440px page overflow, dark controls, active mobile navigation, labeled calculator/login controls, the code page (title, path, remedies split, card heights, warning vs recovery hue), self-hosted fonts (a recorded, unblocked load makes no request to googleapis/gstatic) and browser runtime errors. The other checks in the suite still block font hosts to keep navigation stable.

`node tests/draft.test.mjs` (ports 3351/3352, 21 checks): the draft is written after an anonymous run and on any sign-up/sign-in link, never for the sample or empty text, holds no results; restore is explicit and does not run the audit; discard, 24-hour expiry, sign-out and save clear it; disabled and full storage change nothing; the `?next=` allowlist rejects `https://evil.example`, `//evil.example`, `/api/x` and a `next` injected into the form.

`node tests/contrast.test.mjs` (ports 3361/3362, 11 checks): for `/`, `/audit` (empty, sample, problem, results, draft notice), `/account`, `/alerts`, `/hts/6109.10.00.12`, `/calculator` (form and result), `/login` and `/signup`, the browser's computed foreground and composited background of every visible piece of text are measured in light, system-dark, explicit-dark and explicit-light (each mode is verified to be in effect), failing below 4.5:1 (3:1 for large text). A self-check confirms the previous `--faint` would be caught.

Validation during this change used an isolated copy of the frontend and an optimized Next.js webpack build, keeping active development output and databases untouched. No claim is made that this UI validation certifies tariff calculations or every backend workflow.

Final results: optimized production webpack build and its TypeScript check passed; focused UI suite 6/6, existing catalogue review suite 26/26, and unsigned-save check 1/1 passed. ESLint reports no errors and five existing unused-variable warnings in other tests. `git diff --check` passed. The browser checks verified both failed-run recovery and successful save/export behavior, not just screenshots.
