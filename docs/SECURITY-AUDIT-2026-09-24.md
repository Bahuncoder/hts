# Security review — 24 September 2026

Reviewed baseline: `7cb13be`. This report describes current findings; older audit reports may describe issues subsequently fixed. No production data was modified. Severity reflects application impact and the prerequisites below, not a formal CVSS score.

## Findings, in remediation order

### 1. High: reset completion allows unauthenticated CPU exhaustion

**Location:** `web/src/lib/actions.ts:311–321`, `web/src/lib/auth.ts:16–19`.

`completeResetAction` accepts a password, runs synchronous scrypt, and only then checks the reset token. It has no attempt reservation. The throttle on requesting a reset email does not protect this separate action. An invalid token still incurs the expensive work. Hiding the form on the reset page is not authorization for the server action.

Ten bounded local calls using exactly the configured scrypt parameters occupied the thread for **593 ms**. This is a primitive benchmark and source-confirmed call path, not a production load test. Repeated requests can block the Node event loop and delay unrelated users. Actual throughput depends on hardware, worker count, and edge controls.

**Fix:** reserve a completion-attempt budget before hashing; reject malformed and unusable tokens before expensive work; use asynchronous hashing with bounded concurrency. Retain the final transactional token check, password update, and session revocation so preliminary validation does not introduce a race.

### 2. Medium: Python API limiter can oversubscribe across workers

**Location:** `api/security.py:82–103`.

The count and insertion are separate operations; the Python lock protects only one limiter instance/process. Two workers can observe the same remaining capacity and both admit work.

**Reproduced:** two independent connections to a temporary SQLite database, four existing audit hits, and two requests synchronized immediately after the count. Both were admitted; stored hits became **6 against a limit of 5**. Synchronization exposes the real interleaving; no production endpoint was flooded. This is bounded oversubscription per race, not proof of an unlimited bypass.

**Fix:** make the quota decision and reservation one atomic SQL operation, or use a write transaction acquired before counting. Test with separate connections/processes, not only threads sharing the same instance.

### 3. Medium: repricing can retain approval for changed figures

**Location:** `web/src/lib/reprice.ts:118–180`, `web/src/lib/review.ts:104–123`.

Repricing commits new item figures and catalogue metadata first. Reopening approval happens later and is best-effort. Its boolean result is ignored and exceptions are swallowed. The review-event cap can reject this mandatory reopening; a process interruption or database failure can leave the same inconsistent state.

**Reproduced component failure:** in a temporary catalogue, approve an item and seed review events beyond the cap. The real `setApproval(..., "pending")` returns `false` and the item remains `approved`. This verifies the silent reopening failure; the complete repricing HTTP flow was not exercised for this cap case.

There is also a stale-screen path: repricing does not increment `review_version` in the price transaction. A previously pending item can be approved using a form rendered before the prices changed. The reopening loop only considers items that were approved in the original snapshot, so this approval can survive.

**Impact:** reports can show approval beside figures the reviewer never approved. This is a workflow/data-integrity bug, not evidence of cross-account access.

**Fix:** commit calculation revision, review-version increment, approval invalidation, and system event together. Mandatory invalidation must work even when the user-comment cap is reached. Approval submissions should bind to the calculation revision being reviewed. Preserve the previous revision for historical evidence.

### 4. Medium, deployment-dependent: auth fallback shares one global client budget

**Location:** `web/src/lib/throttle.ts:24–33`, `web/src/lib/attempts.ts`; `ops/preflight.py:98–99`.

Without trusted proxy mode, every client is identified as `local`. With the current 60-attempt client allowance, one visitor can exhaust the shared login budget using different email addresses, preventing other users from signing in until the window clears. The same structure affects other credential scopes independently.

Enabling proxy mode is safe only if the ingress overwrites/appends the header consistently and the origin cannot be reached directly. Otherwise the trusted forwarded value can be supplied by a caller. Preflight warns about this configuration but does not establish that the deployment satisfies it.

**Fix:** require and verify a trusted ingress arrangement for public production, obtain client identity from that boundary, and enforce additional edge limits. Keep the per-account/email protection. Do not blindly enable forwarded-header trust.

### 5. Medium/low: Python dependency pins include published advisories

**Location:** `requirements.txt` (`idna==3.6`, `certifi==2023.11.17`).

- `idna` is below the patched version 3.15 for resource exhaustion on crafted domain inputs. The affected pin is confirmed; an attacker-controlled domain reaching this application's network stack was not established. [Maintainer advisory GHSA-65pc-fj4g-8rjx](https://github.com/kjd/idna/security/advisories/GHSA-65pc-fj4g-8rjx).
- `certifi` predates removal of the distrusted GLOBALTRUST root in 2024.07.04. This unnecessarily broadens trust for outbound HTTPS using this bundle. It does not mean every TLS connection can be intercepted. [Maintainer advisory GHSA-248v-346w-9cwc](https://github.com/certifi/python-certifi/security/advisories/GHSA-248v-346w-9cwc).

**Fix:** regenerate and test maintained dependency pins, including a complete Python advisory scan. Updating these two packages alone is not a complete dependency review. Pillow is used by the ingestion pipeline and should be included in that scan.

### 6. Medium, deployment-dependent: verification POST parses an unbounded form

**Location:** `web/src/app/verify/route.ts:16–24`.

The route calls `request.formData()` before token validation, without the explicit streaming size bound used by other APIs. A non-browser caller can supply an accepted Origin header; the origin check is CSRF protection, not a resource-abuse barrier. Large/multipart submissions can consume parser memory and CPU. This is a source-confirmed missing application bound; effective deployment limits and maximum memory impact were not measured.

**Fix:** accept only the small expected content type, enforce a streaming byte cap, validate token shape, and apply a request budget before token work. Also set ingress body/time limits. A server-action body limit should not be assumed to cover this route handler.

### 7. Low: saved cost changes have no version check or change history

**Location:** `web/src/app/api/catalogues/costs/route.ts:18`.

The account predicate correctly protects ownership, but updates overwrite the entire cost object without an expected version or a historical record. Two tabs can silently overwrite each other's freight/FX assumptions. Later exports contain the latest values without explaining previous cost edits.

**Fix:** optimistic concurrency with a conflict response, plus an append-only cost-change record containing actor, previous/new assumptions, and timestamp. This is an integrity/accountability limitation, not an authorization bypass.

## Checks and evidence

- `node tests/landed-cost.test.mjs` — passed rounding, invalid-input, evidence/proof, and origin checks.
- `node tests/catalogue-costs.test.mjs` — passed ownership isolation, quota reservations, concurrent token supersession, reset transaction rollback/replay, stale-password session rejection, review concurrency, and persistence checks against fresh temporary databases.
- Python API quota race — reproduced as described above using temporary storage.
- Bounded scrypt benchmark — 10 hashes, 593 ms on this machine.
- `npm audit --omit=dev --json` — **0 known production dependency advisories returned**. This is not proof of application security and does not cover development dependencies or Python packages.
- Source tracing covered credential actions, session creation/reset, Google OAuth callback, account-scoped catalogue updates, review transitions, repricing, evidence handling, verification routes, API throttling, and relevant ingestion execution sites. The inspected ingestion subprocess calls use argument arrays; no shell-injection finding was established there.

The current checks did not establish account takeover, cross-account catalogue access, arbitrary SQL execution, or remote code execution. Existing fixes for reset transaction races and account-scoped review writes passed their regressions; they should not be reported as still vulnerable.

## Limits and next validation

This is a targeted source and isolated-test audit, not a claim that every repository line or production infrastructure component is verified. Production proxy configuration, TLS, secret handling in deployment, external mail/OAuth providers, backup access, and a full Python dependency scan remain outside the verified boundary. The earlier browser reset journey stopped on a form locator timeout and is not counted as passing here; database-level reset tests passed.

Prioritize reset resource controls, atomic API quota admission, and atomic repricing/review transitions. Then address deployment identity/body limits, dependency updates, and cost history. Each fix needs a regression for the failing path above.
