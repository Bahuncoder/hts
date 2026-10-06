# Security audit — 2026-10-06

Original audit reviewed commit `c8ae65815bb8e61a4264481bf7c5f0441afc2b37`. The findings below describe that snapshot. Subsequent remediation is now implemented in the workspace.

## Remediation status — 2026-10-06

All six numbered findings are fixed:

| ID | Implemented change |
| --- | --- |
| S01 | Production password signup requires email verification. Google identities bind to stable `sub`. Recovery of an unverified account atomically replaces its password and revokes sessions, API keys, and authentication tokens. Verified accounts retain their password. Conflicting subjects cannot adopt an account by matching email. |
| S02 | One atomic SQL insertion checks and reserves both quota scopes across independent database clients. Unique reservation IDs isolate refunds and make them idempotent. |
| S03 | Audit, refund-check, checkout, and billing-portal POST handlers enforce same-origin requests before authenticated work. |
| S04 | Sessions store SHA-256 digests. Migration invalidates legacy plaintext sessions. A database digest cannot authenticate as a cookie. |
| S05 | API-key insertion checks the active-key cap atomically. |
| S06 | Checkout bodies are capped at 4 KiB and webhook bodies at 256 KiB, including streamed bodies. |

Next.js and its ESLint configuration are now 16.4.0, sharp is 0.35.5, and source-map-js is 1.2.2. Other affected dependencies were updated. The lint glob chain had no compatible patched braces release; a local fast-glob adapter implements Next's used globSync interface with tinyglobby. Adapter tests cover default roots, absolute brace patterns, and arrays. An isolated clean npm ci and dependency-tree check passed. The refreshed npm audit reports **zero known vulnerabilities**; see `docs/security-audit-2026-10-06/npm-audit-after-fixes.json`. Original scan artifacts remain historical evidence.

Verification: security regressions 11/11; Google authentication 15/15; origin checks 5/5; billing 15/15; API keys 14/14; refund checks 26/26; audit 15/15; proof integrity 11/11; migrations 9/9; authentication races 8/8; repricing/review races 3/3; corrections 8/8; browser draft restoration 22/22. Catalogue-cost and evidence checks, browser password reset/revocation, production signup refusal without mail, and the end-to-end feature journey passed. Lint, TypeScript checking, and the production build passed.

Deployment has not been performed. Deploy the web changes together: schema migration runs automatically and existing sessions must sign in again. Configure email delivery for password signup, or use Google sign-in. Additional observations below remain separate operational follow-ups; deployed infrastructure and real provider settings were not verified.

## Assessment

The most serious application issue is conditional account pre-hijacking: a Google login can adopt an account created without email verification while preserving the attacker's password and sessions. A separate, reproduced concurrency issue bypasses the shared audit quota through line corrections. Cookie-authenticated route handlers also have inconsistent CSRF checks, and session credentials are stored in recoverable form.

Existing authentication races, tenant ownership, signed audit integrity, Stripe signature/replay handling, and B2B account metering have useful regression coverage and passed the selected tests. Those results do not cover the new quota race or the unsafe OAuth linking policy; an existing Google test explicitly expects that linking behavior.

No production endpoint or real provider was attacked. HTTP probes used the production Next.js bundle, disposable databases, fake Google and engine services, and loopback ports. The Python API regression server read the existing reference dataset and used temporary rate-limit state. Deployed Vercel/Turso settings, firewall rules, real Google configuration, and live TLS were not inspected. Browser cookie delivery was not exercised by the new HTTP probes.

## Findings

| ID | Severity | Finding | Evidence |
| --- | --- | --- | --- |
| S01 | High, conditional | Google linking preserves credentials from an unverified account | Reproduced through production callback |
| S02 | Medium | Concurrent corrections bypass the account audit quota | Eight engine calls with one request remaining; total 17/10 |
| S03 | Medium, conditional | Cookie-authenticated POST routes lack an origin boundary | Cross-origin text/plain audit POST returned 200 and charged account |
| S04 | Medium, defense in depth | Database sessions contain usable bearer credentials | Database token authenticated an HTTP request |
| S05 | Low | API-key count limit uses a non-atomic check and insert | Source review; no HTTP race reproduction |
| S06 | Low on documented hosting; Medium if exposed without an edge cap | Billing/webhook bodies lack application size limits | Source review; no memory-exhaustion attack |

Severity describes this application's attack conditions, not a scanner's package severity. Dependency results are recorded separately below.

### S01 — Account pre-hijacking through Google email linking

Locations: `web/src/lib/actions.ts:60`, `web/src/app/api/auth/google/callback/route.ts:58`, `web/src/lib/auth.ts:87`.

With no mail provider, signup immediately creates an unverified account and session for any supplied email. Google callback later finds accounts by email alone. For an existing account it marks the email verified, retains the old password hash, and starts another session; it does not revoke the earlier sessions.

Attack sequence:

1. When verification-free signup is available, an attacker registers the target's email with an attacker-chosen password.
2. The email owner later signs in using their genuine, verified Google account.
3. The owner's new data and subscription attach to the preclaimed account. The attacker retains their session and can continue authenticating with the unchanged password.

The probe seeded exactly the account/session that the fallback signup creates. It then exercised the real Google start and callback routes against fake verified userinfo. Callback issued a session and marked the account verified while leaving the attacker hash and existing session intact. This reproduces the linking defect; the probe did not submit the fallback signup form itself.

Prerequisites: Google login enabled and an unverified account previously created through the no-mail fallback or another unverified/legacy import. A site that has always enforced verification has a narrower exposure. Simply turning email delivery on now does not repair legacy unverified accounts.

Remediation: disable verification-free registration in production. Do not auto-link an unverified password account by email. Require an authenticated linking/recovery flow, or an explicit ownership transition that atomically replaces the untrusted password and revokes prior sessions and API keys. Persist the provider identity (`issuer`, `sub`) for future OAuth logins. Test the transition with an attacker password and live attacker session. Email ownership should be established before account use; see [OWASP email verification guidance](https://cheatsheetseries.owasp.org/cheatsheets/Email_Validation_and_Verification_Cheat_Sheet.html).

### S02 — Shared quota checks race under different item leases

Locations: `web/src/lib/correction.ts:93`, `web/src/lib/budget.ts:83`.

`chargeAudit()` reads request and item usage, then inserts two separate charge rows. Its documented precondition is that the caller holds the subject's lease. Ordinary audits and repricing lock `account:<id>`, but corrections lock `account:<id>:item:<itemId>` while charging the shared account subject. Different items can therefore all read the same remaining quota and each proceed. A correction can also race an ordinary audit or repricing run.

Reproduction used both the real budget functions and `proposeCorrection()`:

- Eight distinct item leases and concurrent charges against a one-request cap admitted eight requests.
- A free account was seeded with nine requests used out of ten. Eight actual correction calls for different items all reached the fake engine; stored request usage became seventeen.

The fake engine intentionally returned a minimal response; successful proposal persistence is unnecessary to reproduce the cost-control defect because engine work already ran and usage already committed. This is not a cross-account access issue or proof that all other budget scopes race. Ordinary B2B request serialization passed.

Remediation: reserve request and item quotas inside a single database write transaction, independently of the engine-work lease. Include both checks and both records in the transaction. Preserve item-level parallelism if useful, but place an explicit account-wide concurrency ceiling on engine work. Use unique reservation IDs for refunds rather than a shared subject/timestamp selector. Test correction/correction and correction/audit races across independent database connections.

### S03 — Missing CSRF origin checks on cookie-authenticated routes

Locations: `web/src/app/api/audit/route.ts:86`, `web/src/app/api/refund-check/route.ts:66`, `web/src/app/api/billing/checkout/route.ts:9`, `web/src/app/api/billing/portal/route.ts:11`.

These route handlers use browser sessions without the `sameOrigin()` check used by catalogue cost saving and verification. The audit and refund routes parse JSON from text regardless of media type, and checkout uses `request.json()` without enforcing JSON media type. An attacker can send a simple `text/plain` fetch containing JSON, avoiding a CORS preflight. The response need not be readable for the action to occur.

The HTTP probe sent a session-bearing audit request with an unrelated Origin, `Sec-Fetch-Site: same-site`, and `Content-Type: text/plain`. It returned 200 and spent the account's audit quota. This demonstrates acceptance at the server boundary; the client was Node fetch and manually supplied the cookie.

Browser prerequisite: a hostile origin that is **same-site** with the application, such as an attacker-controlled sibling HTTPS subdomain. SameSite=Lax normally prevents authenticated cross-site fetch POSTs from an unrelated site, so the result does not establish arbitrary cross-site account compromise. Host-only cookies still accompany a fetch directed to the application itself from a same-site sibling. Quota consumption and unwanted refund-check records are the principal impacts; creating a checkout session does not by itself charge a card, and CORS normally prevents reading the returned portal URL.

Remediation: enforce `sameOrigin(request)` before reading the body or performing authenticated side effects, consistently across cookie-authenticated POST handlers. Enforce expected content types and use an explicit CSRF token if legitimate cross-origin browser calls are needed. Bearer-key API calls and Stripe webhooks need their existing credential/signature checks, not a browser-origin requirement. Test sibling-origin requests as well as unrelated origins.

### S04 — Session storage turns read-only database disclosure into session takeover

Locations: `web/src/lib/credentialStore.ts:8`, `web/src/lib/auth.ts:107`, `web/src/lib/auth.ts:123`, `web/src/lib/store.ts:109`.

Session insertion stores the raw cookie token as the database primary key; viewer lookup and logout use the same raw value. Sessions last thirty days. A database export, backup, read-only SQL access, or leaked Turso credential therefore yields immediately usable login credentials rather than only customer records and password hashes.

The probe read a session token from the scratch database and used it as the cookie on a protected export endpoint. It received authenticated 404 for a nonexistent catalogue, rather than anonymous 401. This finding assumes database read access; no database disclosure vector was established by the audit.

Remediation: generate the existing high-entropy browser token but store and look up only its SHA-256 digest, as the application already does for reset tokens and customer API secrets. Apply the same digest transformation to logout. Expire/migrate old sessions deliberately and test reset revocation after migration. Hashing helps with a read-only leak; it cannot protect against an attacker who can write account/session records.

### S05 — API-key count ceiling is not atomic

Locations: `web/src/lib/actions.ts:398`, `web/src/lib/apiKeys.ts:44`, `web/src/lib/store.ts` (`insertApiKey`).

The create action counts active keys, compares the plan cap, then separately inserts a new key. Concurrent requests can all observe a remaining slot and exceed `maxKeys`. The insertion does not enforce the count in a transaction or predicate. This was identified by source review, not a reproduced server-action race.

Impact is limited: extra keys still share an account's API budget, and the existing tests confirmed that different keys cannot multiply the daily allowance. This is a plan-limit and credential-management integrity defect, not a demonstrated privilege escalation.

Remediation: enforce the active-key count and insertion inside one write transaction at the store boundary. Keep the user-facing precheck if desired, but treat the transactional result as authoritative.

### S06 — Billing and webhook bodies are buffered without an application cap

Locations: `web/src/app/api/stripe/webhook/route.ts:39`, `web/src/app/api/billing/checkout/route.ts:16`.

Webhook reads the complete body before verifying its signature. Any nonempty `stripe-signature` header reaches `request.text()` when billing is configured. Checkout similarly buffers an authenticated request through `request.json()`. These paths do not use the capped reader available in `requestBody.ts`. No large-body exhaustion test was performed.

On the documented Vercel deployment, hosting request limits can bound this, so this is low-severity application hardening. On an uncapped self-hosted Next server, concurrent oversized unauthenticated webhook requests can consume memory before failing authentication. The supplied nginx configuration fronts the Python engine, not the Next billing handlers; its cap does not establish protection for these routes.

Remediation: use a modest streamed byte cap on the raw webhook text before signature verification, retaining the exact bytes for Stripe verification. Cap checkout JSON independently, reject oversized declared lengths early, and retain a streamed cap for chunked requests. Configure matching edge request limits and timeouts for the web application.

## Dependency scan and applicability

Raw results: [npm audit](security-audit-2026-10-06/npm-audit.json), [Python audit](security-audit-2026-10-06/pip-audit.json).

`npm audit` reported **nine vulnerable package entries: one critical and eight high**. These include transitive/metavulnerability entries and are not nine independently reachable application exploits. Python scanning found **zero known vulnerabilities in the eighteen requirements pins** using `pip-audit --no-deps --disable-pip`. The Python scan checks the supplied pins; it is not an installed production-environment or OS-package inventory.

| Package / group | Locked version | Scanner result | Application applicability and action |
| --- | --- | --- | --- |
| Next.js | 16.3.5 | Critical, GHSA-vcvr-r3jv-pc5j | Advisory affects Node `next/og` with attacker-controlled SVG. No `ImageResponse`/`next/og` use was found in application source; no reachable RCE established. Upgrade; advisory fix starts at 16.3.6. |
| sharp | 0.35.4 | High, GHSA-wq5f-xc86-pv6w | Requires affected SVG decoding/runtime conditions. No direct sharp call, configured remote image sources, or application `next/image` usage was found. Upgrade to at least 0.35.5; no RCE reproduced. |
| source-map-js | 1.2.1 | High, indexed source-map DoS | Build/source-map tooling dependency; no public untrusted source-map input path found. Update to at least 1.2.2. |
| brace-expansion | 1.1.18 and 5.0.9 | High, recursive expansion DoS; additional moderate advisory | Development dependency. Update to advisory-complete fixes (1.1.21 / 5.0.12 or compatible newer versions). |
| braces / micromatch / fast-glob / Next ESLint packages | braces 3.0.3 | High direct/transitive entries | Development globbing/lint chain. Resolve against current compatible patched releases; do not blindly accept the scanner's proposed downgrade of eslint-config-next to 14.x. |

The maintained [Next ImageResponse advisory](https://github.com/vercel/next.js/security/advisories/GHSA-vcvr-r3jv-pc5j) explicitly limits applicability to attacker-controlled SVG inputs in the Node implementation. The [sharp advisory](https://github.com/lovell/sharp/security/advisories/GHSA-wq5f-xc86-pv6w) describes runtime-dependent librsvg exposure. These dependencies should still be patched because adding an image feature can make a previously unreachable flaw relevant.

The newer [Next cache-poisoning advisory](https://github.com/vercel/next.js/security/advisories/GHSA-mcj8-r9mp-w47p) requires a root catch-all page combined with SSG/ISR. This repository has no root catch-all page. Its published patched-version fields were unresolved when checked; do not invent a precise fixed version from that page. Choose a currently supported patched release and repeat the scan and build tests.

## Additional observations and limits

- Engine keys deliberately bypass application throttling. nginx is the outer bound for keyed traffic. Verify the deployed engine cannot be reached around the configured reverse proxy and that its edge limits tolerate legitimate web traffic while bounding aggregate work.
- Audit's 45-second budget is checked between items, not during classification. Reasoning makes a synchronous HTTP call with a 90-second timeout. With reasoning explicitly enabled, the 55-second web timeout can expire first; web refunds and releases its lease while engine work may continue. Source review establishes this deadline mismatch, but the audit did not simulate a slow real model or establish a live saturation attack. Propagate a remaining deadline into reasoning and reconsider refunds when work may already have run.
- `ingest/fedreg.py:143` fetches upstream-provided `raw_text_url` and follows redirects without a destination allowlist. This is an upstream-trust SSRF surface, not a public-input SSRF exploit. Consider validating the scheme, permitted hosts, resolved addresses, redirects, and response size.
- No application `dangerouslySetInnerHTML`, `eval`, or dynamic shell construction from public inputs was found. React rendering and export/report escaping passed selected tests. SQL review found public values passed as bound parameters; dynamic table/column SQL is used for internal schema operations. These are review results, not formal guarantees against all injection paths.
- No obvious live credential was identified in the reviewed application/configuration files; environment examples contain placeholders. This was not an exhaustive historical secret scan, and neither local secret files nor live cloud credentials were dumped.
- CSP has no script restriction. This is a defense-in-depth gap already acknowledged in `next.config.ts`; no application XSS was established. A nonce strategy would require measuring its effect on static rendering.
- A stock restore script copies a live local database file before replacement and tells the operator to restart afterward. Stop the local web process before restore, and preserve a consistent pre-restore snapshot using SQLite backup. No restore was attempted against customer data. Production Turso restoration has separate operational requirements.

## Verification and reproduction

Updated regressions: `web/tests/security-audit-2026-10-06.mjs`. The original probes reproduced vulnerabilities; the suite now asserts secure outcomes and adds concurrency, migration, key-limit, and body-cap coverage. PASS now means the expected prevention succeeded. Run from `web/`:

```sh
npm run test:security
```

The probes use loopback ports 3515–3517, a fresh scratch accounts database, and fake providers. Existing harness safeguards reject tests against an existing database by default. The expected-secure suite is available through `test:security`.

Selected existing tests passed: credential/token races (8/8); audit proof and tamper rejection (11/11); catalogue cost persistence, quotas and ownership; repricing/review races (3/3); line corrections (8/8); billing signatures, retries and reconciliation (15/15); B2B authentication/plan/metering (14/14); refund checks and ownership (26/26); evidence export, CSRF and escaping; Google state checks (12/12). Python rate-limiter checks passed 3/3, the private backup check passed 1/1, and the isolated Python API contract/security suite passed 42/42. The catalogue and evidence scripts report successful grouped checks without numerical totals, so no count is invented for them.

## Original remediation priorities

1. Close unverified registration/linking and investigate legacy unverified accounts before offering Google sign-in to them.
2. Make budget reservation transactional and test competing correction/audit callers.
3. Add origin checks to cookie-authenticated POST routes and hash stored session credentials.
4. Update vulnerable dependencies with compatible versions; repeat vulnerability scans and production regression tests.
5. Enforce transactional key-count limits and streamed billing/webhook body caps; verify deployed edge controls and timeout/cancellation behavior.

The original audit made no application changes. Subsequent remediation is recorded at the top of this report.
