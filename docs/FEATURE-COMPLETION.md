# Existing feature completion

## Landed-cost assumptions

Audit costs now travel with the save request and are stored on the catalogue as `landed_cost_json`. They are user estimates, separate from the signed tariff calculation. Existing catalogues default to zero additional costs. Saved catalogue owners can edit and save the amounts, and JSON evidence exports and printable reports read the stored values.

All amounts are USD, nonnegative, finite, bounded and limited to cents. The calculator adds goods, existing duty/fees and additional costs; it does not add MPF twice or deduct potential refunds. Partial and legacy catalogues are labelled as partial estimates. Cost-field labels and input validation live in `lib/landedCost.ts`.

## Evidence record

Saved catalogues provide a JSON download and a printable report with browser PDF export. Both read the account-scoped catalogue. Every saved line, including failed lines, remains visible. Legacy completeness is unknown rather than silently reported as complete. The report includes calculation date, data revision, assumptions, amounts and review notes.

Ruling snapshots and human approvals were not stored by the existing audit-save model. Reports explicitly say these are unavailable. Capturing and signing ruling evidence for future audits and adding reviewer history remain separate work; this report does not fabricate either.

## Security corrections

Backups are compressed as gzip again while retaining private permissions. Verification validates token shape before HTML rendering, checks POST origin and verifies an address without switching the current session. Standalone watches have a centralized count cap, and client identity ignores untrusted X-Real-IP when proxy trust is disabled. Browser responses now carry anti-framing and basic security headers.

Remaining audit hardening includes atomic credential throttling, reset/session race handling and token supersession. These are not represented as resolved by this feature work.

## Focused checks

- `node tests/landed-cost.test.mjs`
- `node tests/catalogue-costs.test.mjs`
- `node tests/evidence.test.mjs` (production HTTP integration; scratch DB, localhost only)
- `python3 -m unittest discover -s tests -p test_backup_security.py`
- TypeScript, ESLint, production build and diff whitespace checks.
