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

**Fixed** with a per-client limiter (`api/security.py`) at 120/min for lookups,
20/min for classification and 5/min for audits, returning 429 with
`Retry-After`. Keyed callers bypass it.

> The counter lives in a small SQLite database shared by every worker (finding
> 14), so it does not multiply with `--workers`; it survives restarts but not a
> second host. nginx holds the outermost limit (`deploy/nginx.conf`) and is the
> only one that also covers traffic carrying a valid key. Because the web app's
> key bypasses this limiter, the web app meters what each caller may submit
> before forwarding (`web/src/lib/budget.ts`): per-client and per-account audit
> budgets, one audit in flight per caller, and a streamed body cap. Moving
> beyond one host needs a shared counter instead.

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

### 11. Signup confirmed which emails are registered — medium, fixed

Signing up with an existing address returns "An account with that email already
exists", which is an enumeration oracle: it tells an attacker who uses HTSDesk.

**Fixed** by not creating the account synchronously. With a mail provider
configured, signup stores a verification token carrying the already-hashed
password and returns "Check your inbox" — *identically* for a new address and a
registered one. The difference is carried in the mail itself: a new address
gets a confirmation link, a registered one gets a password-reset link. The
account is created only when the link is used, so an unverified address leaves
no record at all.

Verified: both branches return byte-identical text. The reset form behaves the
same way, answering "if that address has an account…" whether or not it does.

Without a provider configured the old behaviour remains, because an account
must still be creatable; the throttle is what limits harvesting there. That
fallback is what `tests/authflow.test.mjs` checks when it detects no mail
provider.

### 12. No password reset — medium, fixed

A customer who forgot their password had no route back in.

**Fixed** with single-use, one-hour tokens. Only a SHA-256 of the token is
stored, so a leaked database yields no working links, and lookup is by hash so
there is nothing to compare in variable time. Issuing a new token invalidates
any outstanding one. **Completing a reset deletes every session for that
account** — a reset is what someone does when they think they are compromised,
and leaving the intruder signed in defeats the point. Verified by test.

### 13. Verification crashed after doing its work — high, fixed

Found in testing, not review. `/verify` was a page, and it called
`cookies().set()` during a Server Component render, which Next refuses. The
account was created and then the request returned **HTTP 500** — the work
succeeded and the customer saw a crash, with no way to tell which.

**Fixed** by moving it to a Route Handler, where cookie writes are allowed, and
redirecting to `/account` on success or back to signup on a spent link.

### 14. Throttle state lived in process memory — medium, fixed

The credential throttle counted in a module-level map. Two workers gave an
attacker twice the configured budget, and every deploy reset it.

**Fixed** by counting in the database, so the limit holds across workers and
across instances sharing the file. The duty engine's own limiter had the same
flaw and was moved the same way; verified by exhausting the budget from one
limiter object and confirming a second — standing in for a second worker — was
refused immediately.

### 15. The accounts database was world-readable — high, fixed

Found by the preflight check, on a working machine: `accounts.db` sat at mode
0644. SQLite creates a file with the process umask, which on a default host
leaves every account, catalogue and alert readable by any local user.

**Fixed** by forcing 0600 when the database is opened, so it is corrected on
every start rather than depending on how it was first created. The engine's
runtime counter is treated the same way.

### 16. Nothing watched the audit log — medium, fixed

Events were recorded and shown to the customer, but nothing looked at them.
A log nobody reads is filing, not security.

**Fixed** with a daily scan for credential stuffing against one address,
spraying across many, throttle trips, and resets completed without a matching
request. Thresholds sit above ordinary human error — four mistyped passwords is
not an incident — because an alert that fires every day gets filtered into a
folder and stops working. Findings email `HTSDESK_SECURITY_EMAIL` when set.

---

## Third audit — the duty engine

The engine was hardened first and then left alone while the account layer grew
around it. Re-attacked, it had four issues, all fixed and covered by
`tests/test_api.py`.

### 17. The whole API surface was published — medium, fixed

FastAPI serves `/docs`, `/redoc` and `/openapi.json` by default. All three
answered: ten paths and five request schemas, handed to anyone who asked. That
is a map of every parameter worth attacking, including the ones with the
tightest limits.

**Fixed.** They are off unless `HTSDESK_ENABLE_DOCS=1`, so they stay available
in development and are absent in production.

### 18. Health disclosed operational state to anyone — low, fixed

`/api/health` returned row counts, build timestamps and `reasoning_enabled` to
an unauthenticated caller. Together those say how complete the data is, when it
was last refreshed, and which code path a classification will take — the last
being useful to anyone probing for the slower one.

**Fixed.** Anonymous callers get `{"status": "ok"}`, which is everything a
health check needs. Detail requires a key.

### 19. The dataset could be walked without a key — medium, fixed

`/api/sitemap` was unmetered and returned ten thousand codes per call, with
chunk indices to a hundred. That is the entire schedule, and the assembled
dataset is the thing worth having. `/api/chapters` was similarly open.

**Fixed.** Both now sit behind the standard meter. Our own build passes the
engine key and is unaffected — that key is read server-side and never reaches
the browser.

### 20. The server advertised itself — low, fixed

Responses carried `server: uvicorn`, which narrows an attacker's search for a
matching advisory and tells a legitimate caller nothing.

**The obvious fix did not work.** Setting the header in application middleware
produced *two* `Server` headers, because uvicorn writes its own at the ASGI
layer after the application has run. It is suppressed with
`--no-server-header` on the command line instead, and the middleware carries a
comment saying why it is not done there.

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
- **Reset and verification links.** Single-use and expiring, stored only as a
  hash, superseded when a new one is issued, and refused once spent.

---

## Open risks

Accepted for now, listed so they are not forgotten.

1. **Signup enumeration returns without a mail provider.** See finding 11: the
   fix depends on email being configured. Until a key is set, the fallback is
   throttled but visible.
2. **Engine API keys are a static allowlist** in an environment variable — no
   per-customer key, rotation or usage metering. Customer-facing traffic goes
   through the web app's session, so this affects only direct engine access.
3. **The reasoning layer's accuracy is unmeasured.** The code path itself has
   now been exercised against a stub: with a key set the model reorders
   candidates, attaches reasoning and surfaces missing facts. A deliberately
   hostile stub — inventing `9999.99.99.99`, returning unrelated codes and
   embedding markup — changed nothing: every code returned was one that
   retrieval had already found, and each was a real HTS line. So the model
   cannot introduce a classification. What remains unmeasured is whether its
   reordering is *better*, which needs a real key.
5. **Ingest trusts upstream.** CROSS and Federal Register responses are parsed
   without schema validation. Both are government sources reached over HTTPS;
   a malformed response degrades data quality rather than executing anything.
6. **The audit log is not alerted on.** Events are recorded and shown to the
   customer on their account page, but nothing watches them for patterns.
