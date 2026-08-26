# Security audit

Audit of the API, ingest pipeline and web app, conducted by attacking a
running instance rather than by reading alone. Every finding below was
reproduced against a live service, fixed, and then locked behind a regression
test in `tests/test_api.py`.

Run the regressions with `make test`.

---

## Findings

### 1. Unauthenticated denial of service via `/api/audit` — critical, fixed

The audit endpoint accepted 5,000 catalogue items and classified each one.
Classification costs ~175 ms of CPU, so a single request — 414 KB, no
credentials — occupied a worker for **14.5 minutes**. Measured, not estimated:
the request had not returned after ten minutes when the test was abandoned.

With two workers, two such requests take the service offline.

**Fixed** by bounding the work three ways, because any one alone is escapable:

| Control | Anonymous | With API key |
|---|---|---|
| Items per request | 25 | 1,000 |
| Hard schema ceiling | 1,000 | 1,000 |
| Wall-clock budget | 45 s | 45 s |
| Requests per minute | 5 | unmetered |

The schema ceiling rejects 5,000 items in **0.20 s** at parse time, before any
work begins. The wall-clock budget stops mid-catalogue and reports
`truncated: true` with the count actually priced, so a partial result is never
presented as a complete one.

### 2. No rate limiting — high, fixed

Every endpoint was unmetered. `/api/classify` costs 175 ms per call, so
saturation was trivial.

**Fixed** with an in-process limiter (`api/security.py`) at 120/min for
lookups, 20/min for classification and 5/min for audits, returning 429 with
`Retry-After`. Keyed callers bypass it.

> The limiter is per process. Running `--workers 2` doubles every application
> limit. nginx therefore holds the authoritative limit in a shared zone
> (`deploy/nginx.conf`); the in-process one is a backstop for direct access.
> Moving beyond one host needs a shared counter instead.

### 3. Unbounded result limits — high, fixed

`/api/search?limit=99999999` and `/api/changes?limit=99999999` were honoured,
returning entire tables. **Fixed**: `limit` is bounded (≤100 search, ≤200
changes), `days` to 1–3650, all via schema so rejection precedes the query.

### 4. Internal exception text returned to callers — medium, fixed

A value of `1e308` produced `{"detail": "[<class 'decimal.InvalidOperation'>]"}`,
disclosing implementation internals.

**Fixed** two ways: `value` is bounded at 1e12 so the overflow cannot occur,
and an exception handler returns an opaque `Internal error` while logging the
detail server-side.

### 5. CORS defaulted to `*` — medium, fixed

`HTSDESK_ORIGINS` defaulted to `*`, so any origin could call the API from a
browser.

**Fixed**: the default is now empty, denying all cross-origin requests. A
deployment that forgets to configure it fails closed.

This broke the browser-side audit, which was the correct signal. Rather than
widen CORS, the audit now posts to a Next.js route handler
(`web/src/app/api/audit/route.ts`) that proxies server-side. This removes the
cross-origin exchange entirely, keeps the engine off the public internet, and
keeps the API key out of the browser — verified: the key appears zero times in
the served HTML.

### 6. Unbounded string fields — medium, fixed

A 10,000-character `country` was accepted and echoed back. **Fixed**: free-text
fields are capped at 400 characters, `sku` at 64, HTS codes at 20.

### 7. Missing security headers — low, fixed

**Fixed**: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` and
`Referrer-Policy: no-referrer` on every response; HSTS at nginx.

### 8. Forgeable client identity — low, fixed

`X-Forwarded-For` is caller-supplied. Trusting it unconditionally lets any
client evade rate limiting by forging the header.

**Fixed**: it is read only when `HTSDESK_BEHIND_PROXY=1`, and only the last
hop is taken. The systemd unit sets it because nginx is in front; a directly
exposed instance must not.

---

## Second audit — accounts, catalogues, export, email

Conducted after the account layer was added, again by attacking a running
instance. Three real findings, all fixed and covered by
`tests/security.test.mjs`.

### 9. CSV export was a formula-injection vector — high, fixed

A product description of `=cmd|' /C calc'!A1` was exported verbatim.
Spreadsheets parse a cell *after* unquoting, so quoting does not help: Excel
and Sheets would offer to execute it on open. `@SUM(1+1)` behaved the same
way.

This is not theoretical here. Descriptions are attacker-controlled — they
arrive from supplier data and uploaded CSVs — and the whole point of the
export is to send it to a broker.

**Fixed** by prefixing any field beginning `=`, `+`, `-`, `@`, tab or carriage
return with an apostrophe, which spreadsheets treat as literal text. Plain
numbers are exempt so a negative figure is not corrupted.

### 10. Sign-in had no rate limit — high, fixed

Twenty consecutive wrong passwords against a known email were accepted without
complaint. That is unlimited, offline-speed guessing against a real account.

**Fixed** with a throttle counting per email *and* per client — either alone is
trivially sidestepped by rotating the other. Measured after the fix: 8 attempts
allowed, 12 refused.

> **The first version of this fix was itself a bug.** It counted every attempt,
> successful ones included, against a client budget of 30 per fifteen minutes.
> A whole office shares one address behind NAT, so a busy Monday morning would
> have locked out colleagues who had done nothing wrong — a denial of service
> against paying customers, dressed up as a security control. It surfaced
> because the browser journey suite started failing to sign in after the
> security suite ran.
>
> Now **only failures count**, a success costs nothing and clears the email's
> tally, and the client budget is 60. The per-email limit is what actually
> stops guessing at one account; the client limit only catches spraying across
> many. Verified by running the full journey immediately after the brute-force
> tests — the exact shared-address scenario.

### 11. Signup confirms which emails are registered — medium, mitigated not closed

Signing up with an existing address returns "An account with that email already
exists", which is an enumeration oracle: it tells an attacker who uses HTSDesk.

**Not fully fixable without email verification.** Any flow that creates an
account immediately must behave differently for a taken address than a free
one, and hiding it strands a real customer who has simply forgotten they
registered — a bad trade on a paid product.

**Mitigated** by throttling signup on the same counters as sign-in, which makes
harvesting a list impractical. **The real fix ships with transactional email**:
signup should then respond "check your inbox" in both cases and verify before
creating anything. Sign-in already gives one message for both failures, and
that is verified by test.

---

## Verified clean

Each was tested, not assumed.

- **SQL injection.** All queries are parameterised. `UNION SELECT` against
  `sqlite_master` returns ordinary product matches — the literal `Unions`
  (HTS 7307.19), which is the correct answer to that text.
- **FTS5 injection.** User text is stripped to word characters before reaching
  `MATCH`, so quotes and operators cannot escape the query.
- **Path traversal.** `../../etc/passwd` in a path parameter does not route.
- **XSS.** No `dangerouslySetInnerHTML`, `innerHTML`, `eval` or `new Function`
  anywhere in the web app; React escapes by default.
- **Secret exposure.** No hardcoded credentials. `ANTHROPIC_API_KEY` is read
  from the environment and never logged, returned, or included in an error.
  Nothing is exposed under `NEXT_PUBLIC_`.
- **SSRF.** Every outbound URL is built from module constants. No user input
  reaches a fetch target.
- **Database access.** The API opens SQLite read-only (`mode=ro`); a SQL flaw
  could not write.
- **Cross-account access (IDOR).** A second account cannot read, export or
  delete another's catalogue. A catalogue belonging to someone else returns the
  same status as one that does not exist, so the response does not confirm it
  is there.
- **Session handling.** The cookie is `httpOnly`, `secure` and `SameSite=Lax`,
  and is not visible to `document.cookie`. No session exists before sign-in, so
  there is no token to fix; the value changes on authentication.
- **Admin endpoints.** The diff runner and email preview refuse a signed-in
  customer, not merely an anonymous one — they are gated on a shared token
  compared in constant time, and refuse outright when it is unset.
- **Unsubscribe links.** Signed with HMAC; a forged token is refused, and one
  customer's token cannot unsubscribe another.

---

## Open risks

Accepted for now, listed so they are not forgotten.

1. **Signup enumeration is mitigated, not closed.** See finding 11; it needs
   transactional email to fix properly.
2. **No password reset.** A customer who forgets their password has no route
   back in without us. This also needs email.
3. **Engine API keys are a static allowlist** in an environment variable — no
   per-customer key, rotation or usage metering. Customer-facing traffic goes
   through the web app's session, so this affects only direct engine access.
4. **Rate limiting is single-host** — both the engine's and the sign-in
   throttle. Several instances need a shared counter; nginx carries the coarse
   limit meanwhile.
5. **The reasoning layer is unmeasured.** With `ANTHROPIC_API_KEY` set, model
   output is parsed as JSON and merged into results. It is constrained to
   reordering supplied candidates and cannot introduce codes, but its accuracy
   has never been measured because no key has been configured.
6. **Ingest trusts upstream.** CROSS and Federal Register responses are parsed
   without schema validation. Both are government sources reached over HTTPS;
   a malformed response degrades data quality rather than executing anything.
7. **No audit log.** Requests are not recorded per caller, so abuse can be
   rate-limited but not attributed.
