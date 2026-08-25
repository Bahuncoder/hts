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

`TARIFFWISE_ORIGINS` defaulted to `*`, so any origin could call the API from a
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

**Fixed**: it is read only when `TARIFFWISE_BEHIND_PROXY=1`, and only the last
hop is taken. The systemd unit sets it because nginx is in front; a directly
exposed instance must not.

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

---

## Open risks

Accepted for now, listed so they are not forgotten.

1. **No authentication or accounts.** API keys are a static allowlist in an
   environment variable. There is no signup, no per-customer key, no rotation
   and no usage metering. This blocks charging anyone and is the next thing to
   build.
2. **Rate limiting is single-host.** See finding 2.
3. **The reasoning layer is unmeasured.** With `ANTHROPIC_API_KEY` set, model
   output is parsed as JSON and merged into results. It is constrained to
   reordering supplied candidates and cannot introduce codes, but its accuracy
   has never been measured because no key has been configured.
4. **Ingest trusts upstream.** CROSS and Federal Register responses are parsed
   without schema validation. Both are government sources reached over HTTPS;
   a malformed response degrades data quality rather than executing anything.
5. **No audit log.** Requests are not recorded per caller, so abuse can be
   rate-limited but not attributed.
