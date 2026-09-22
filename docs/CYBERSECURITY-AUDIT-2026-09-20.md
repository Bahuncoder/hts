# TariffWise security audit

**Scope.** This review covers the current Python API, Next.js application, account store, server actions, backup utility, and deployment configuration. I reviewed the request-to-database paths and exercised the backup path against a fresh temporary SQLite database. No production database, mail provider, engine, or third-party host was contacted.

## Findings

### High — account backups are created world-readable

`ops/backup-accounts.py` creates the destination directory with the process umask and writes the gzip file with ordinary `0666` creation semantics. With a normal `umask 022`, the backup directory is `0755` and the backup is `0644`. The archive contains the account database, including password hashes, session bearer tokens, email addresses, catalogues, and alerts. A local user or another service account that can read the backup can immediately use any unexpired session token.

**Reproduction:** an isolated database and backup produced `644 accounts-*.db.gz` and `775 backups` under `umask 022`. The source database itself also remained `644` in this standalone utility run. The application store later attempts to chmod its live database, but that does not repair existing backups.

**Fix:** create the directory with mode `0700`, create the temporary archive with mode `0600` (or use `os.open` with `0o600`), chmod the final file before rename, and verify the parent path and every retained backup. Prefer encrypting archives and remove raw session tokens from backup material where operationally possible.

### High — standalone watch writes have no input or cardinality limit

`web/src/lib/actions.ts:219` accepts the form value and `web/src/lib/catalogues.ts:241` stores it after only removing periods. There is no HTS shape check, reference-data existence check, maximum length, per-account watch limit, or rate limit. The primary key includes nullable `catalogue_id`; SQLite permits multiple `NULL` values, so repeated writes of the same standalone code are not deduplicated by that key.

An authenticated user can submit very large arbitrary strings or repeat requests to grow the database. The diff worker and account watch views subsequently read and process these rows, turning this into persistent storage and background-work exhaustion. This path is separate from the catalogue item limits.

**Fix:** normalize and validate against the same HTS parser/reference data used by the code page, cap length and number of watches, rate-limit mutations, and add a partial unique index such as `UNIQUE(account_id, digits) WHERE catalogue_id IS NULL` after cleaning existing duplicates.

### Medium — verification link is a login-CSRF primitive

`web/src/app/verify/route.ts:14` performs a state-changing `GET`. `completeVerifyAction` consumes the token and calls `startSession` for the account represented by that token. An attacker can obtain a verification link for an account they control and cause a signed-in victim to visit that URL (image, link, redirect, or embedded browser navigation). The victim's browser is then logged into the attacker's account. Any data the victim enters afterward is saved to the attacker's account and visible to the attacker.

This is not an arbitrary takeover of the victim's existing account, but it is a real login-CSRF/account-confusion issue.

**Fix:** make verification a neutral landing page, require an explicit POST confirmation with a CSRF token, and refuse to replace an existing authenticated session without an explicit sign-out/confirmation step. Keep token consumption and account creation server-side and atomic.

### Medium — client identity can be forged when proxy mode is off

`web/src/lib/throttle.ts:34` uses `x-real-ip` directly whenever `HTSDESK_BEHIND_PROXY` is not `1`. A direct client can send a different `X-Real-IP` on every request and obtain a fresh client bucket. When proxy mode is enabled, the code trusts the last `X-Forwarded-For` value; that is safe only if the configured edge strips and rewrites the header.

This weakens signup/login spray protection and any control keyed to the client identifier. It does not bypass the per-email failure budget by itself, but it makes distributed account spraying materially easier.

**Fix:** derive the address from the platform's trusted request metadata, or accept forwarded headers only after an explicit trusted-proxy allowlist. Ignore all client-supplied `X-Real-IP`/`X-Forwarded-For` values otherwise.

### Medium — budget and credential throttles are check-then-record

`web/src/lib/budget.ts:waitFor` followed by `record`, and `web/src/lib/throttle.ts:overBy` followed later by `recordFailure`, are separate operations. Concurrent requests can all observe spare capacity before any of them records usage. The audit lease closes this gap for audit calls, but classification and credential/signup flows do not have an equivalent atomic reservation.

**Fix:** reserve counters with a transaction/atomic UPSERT (or a lease covering the check and work) and test the reservation under concurrent requests.

### Medium — reset invalidation is not transactional

`web/src/lib/auth.ts:71` updates the password and deletes sessions in separate statements. A concurrent request that has already authenticated can insert a new session after the delete. Token issuance also deletes old tokens and inserts the replacement in separate statements (`web/src/lib/tokens.ts:23`), so concurrent reset requests can leave more than one live reset token.

**Fix:** use a transaction for password update plus session revocation, and make token supersession a single transactional operation with a uniqueness rule for the active token.

### Medium — local SQLite sidecars can retain weaker permissions

`web/src/lib/store.ts:46` enables WAL before `chmodSync(LOCAL_PATH, 0o600)` at line 213. SQLite may create `-wal` and `-shm` sidecars before the main file is tightened; chmodding only the main file does not tighten already-created sidecars. Verify and chmod all three paths, or set a restrictive umask before opening the database.

### Low — browser security headers are incomplete

The Next configuration sets the body limit but does not establish a CSP, `frame-ancestors`/`X-Frame-Options`, `Referrer-Policy`, or a permissions policy. This leaves clickjacking and browser hardening dependent on the hosting platform. Add headers at the Next edge and verify that the Python API and static/error responses receive equivalent protections.

## Positive controls observed

Session tokens are random, HttpOnly, SameSite=Lax, and production cookies are Secure. Passwords use scrypt with a bounded signup length. Catalogue and audit reads consistently include account ownership predicates. Audit results are signed before they can be saved. Safe-next redirects use an allowlist. Reset and verification tokens store SHA-256 hashes and are single-use through a compare-and-set update. The API applies request-size, row-count, and per-account audit limits.

## Priority order

1. Lock down and encrypt backups; rotate any session tokens exposed through existing readable archives.
2. Validate and cap watch writes, clean duplicates, and add the partial unique index.
3. Remove the GET login side effect and add an explicit confirmation/CSRF-protected POST.
4. Replace forwarded-header trust with platform-trusted client identity.
5. Make throttles, reset revocation, and token supersession transactional; then add concurrent regression tests.
6. Add browser security headers and verify them at every deployment boundary.

This is an application review, not a claim of certification or a guarantee that no vulnerability exists in dependencies or infrastructure. Dependency advisories and the actual production proxy/Turso/Vercel configuration should be checked before release.
