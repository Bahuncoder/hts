.PHONY: help data refresh rulings fedreg api web build test test-duty test-api eval check \
        preflight backup restore install mailcatch diff email-preview \
        test-ui test-draft test-contrast test-billing test-apikeys

help:
	@echo "Data"
	@echo "  make data       rebuild reference DB from local sources"
	@echo "  make refresh    re-download HTS + notes + Federal Register, rebuild"
	@echo "  make rulings    resume CROSS ruling body ingest (long running)"
	@echo "  make fedreg     poll Federal Register for tariff actions"
	@echo ""
	@echo "Run"
	@echo "  make api        API on :8099"
	@echo "  make web        Next.js app on :3000"
	@echo ""
	@echo "Verify"
	@echo "  make test       duty unit tests + API security regressions"
	@echo "  make test-duty  duty engine only (no server needed)"
	@echo "  make test-api   API contract + security (needs a running API)"
	@echo "  make test-diff / test-outbox / test-audit / test-migrate / test-billing / test-apikeys"
	@echo "  make test-csvparse / test-proof / test-review / test-ui / test-draft / test-contrast"
	@echo "                  catalogue reader, audit proofs, review workspace (test-review needs Chrome)"
	@echo "                  integration tests against a scratch production server"
	@echo "  make test-journey  browser walk-through of the customer journey"
	@echo "  make test-security attacks the running app"
	@echo "  make test-authflow password reset and email verification"
	@echo "  make eval       held-out classifier accuracy"
	@echo ""
	@echo "Operations"
	@echo "  make preflight  check a deployment before it takes traffic"
	@echo "  make backup     snapshot the accounts database"
	@echo "  make restore BACKUP=<file>   restore one"
	@echo "  make install    install on a fresh host (run as root)"
	@echo ""
	@echo "Jobs"
	@echo "  make diff       match new tariff actions against watched codes"
	@echo "  make email-preview ACCOUNT=<id>  show the digest an account would get"
	@echo "  make check      everything: build, tests, eval"

# --- data -------------------------------------------------------------------
data:
	python3 ingest/build.py

refresh:
	python3 ingest/refresh.py

rulings:
	python3 ingest/cross.py --skip-metadata --bodies 60000 --concurrency 6

fedreg:
	python3 ingest/fedreg.py --days 120

# --- run --------------------------------------------------------------------
api:
	python3 -m uvicorn api.main:app --host 127.0.0.1 --port 8099 --reload --no-server-header

web:
	cd web && npm run dev

# Next persists prerendered pages and ISR output under .next. An incremental
# build reuses them, so an edit to page copy can compile successfully and
# still serve the previous text. Clear it.
build:
	cd web && rm -rf .next && npm run build

# --- verify -----------------------------------------------------------------
test: test-duty test-math test-adcvd test-rate-limiter test-classify-eval test-regimes test-refresh test-api test-email test-diff \
      test-outbox test-audit test-migrate test-csvparse test-proof test-review \
      test-ui test-draft test-contrast

test-duty:
	@python3 tests/test_duty.py

test-math:
	@python3 tests/test_math.py

test-adcvd:
	@python3 tests/test_adcvd.py

test-notes:
	@python3 tests/test_notes.py

test-rate-limiter:
	@python3 tests/test_rate_limiter.py

test-backup-security:
	@python3 -m unittest tests.test_backup_security -v

test-api:
	@python3 tests/test_api.py

test-regimes:
	@python3 tests/test_regimes.py

test-refresh:
	@python3 tests/test_refresh.py

test-classify-eval:
	@python3 tests/test_classify_eval.py

eval:
	python3 tests/eval_classify.py 400

check: build test-duty test-math test-adcvd test-notes test-rate-limiter test-backup-security test-classify-eval test-regimes test-refresh test-api test-email \
       test-diff test-outbox test-audit test-migrate test-billing test-apikeys test-csvparse test-proof test-landed-cost test-evidence test-catalogue-costs test-review \
       test-ui test-draft test-contrast test-journey test-security test-authflow test-auth-transaction test-feature-journey eval

test-email:
	@cd web && node tests/email.test.mjs

# These start their own production server on a spare port (3200-3206) with a
# scratch accounts database and fake engine/mail servers, rebuilding
# first if the bundle is stale. They never touch data/accounts.db.
test-diff:
	@cd web && node tests/diff.test.mjs

test-outbox:
	@cd web && node tests/outbox.test.mjs

test-audit:
	@cd web && node tests/audit.test.mjs

test-migrate:
	@cd web && node tests/migrate.test.mjs

# Stripe webhook idempotency/reconciliation, driven through the real route
# against a fake local Stripe HTTP server with correctly-signed events. Own
# production server (port 3200), scratch accounts database.
test-billing:
	@cd web && node tests/billing.test.mjs

# The public, versioned B2B API (bearer-key auth, plan gating, metering
# independent of the web UI's own budget), driven through the real route
# against a fake engine. Own production server (port 3206), scratch database.
test-apikeys:
	@cd web && node tests/apikeys.test.mjs

# The catalogue reader and shared row model, straight from src/lib (no server).
test-csvparse:
	@cd web && node tests/csvparse.test.mjs

# Saved audits are server-signed: the proxy signs, saving verifies.
test-proof:
	@cd web && node tests/proof.test.mjs

# Landed-cost rounding/allocation and evidence-proof tamper detection, straight
# from src/lib (no server).
test-landed-cost:
	@cd web && node tests/landed-cost.test.mjs

# Evidence export/report: cost saving, validation, CSRF, ownership, report
# escaping. Own production server on a spare port, scratch database.
test-evidence:
	@cd web && node tests/evidence.test.mjs

# Concurrent quota/token/session races plus the review workflow (ownership,
# version conflicts, comment-without-changing-decision), against its own
# scratch database (no server, no browser).
test-catalogue-costs:
	@cd web && node tests/catalogue-costs.test.mjs

# The audit as a review workspace and honest saved catalogues, in a real
# browser against its own production server (3311/3312) and a fake engine.
test-review:
	@cd web && node tests/review.test.mjs

# The workspace UI (home, audit, calculator, sign-in, code page, self-hosted
# fonts) in a real browser on 3378/3380.
test-ui:
	@cd web && node tests/ui-workspace.test.mjs

# An audit surviving sign-up: the client-side draft, its expiry and privacy
# limits, and the allowlisted ?next= return. Ports 3351/3352.
test-draft:
	@cd web && node tests/draft.test.mjs

# WCAG contrast of the rendered text on the main pages, light and dark
# (system and explicit theme). Ports 3361/3362.
test-contrast:
	@cd web && node tests/contrast.test.mjs

# Drives a real browser through the customer journey. Starts its own
# production server (port 3485) with a scratch accounts database, never
# data/accounts.db; needs the real engine running separately (port 8099, for
# real duty figures) and a Chrome on the machine.
test-journey:
	@cd web && node tests/journey.test.mjs

# Attacks its own production server (port 3486, scratch accounts database):
# cross-account access, session flags, credential throttling, CSV formula
# injection, admin gates. Needs the real engine running separately (port 8099).
test-security:
	@cd web && node tests/security.test.mjs

# Password reset and email verification, on its own production server (port
# 3487, scratch accounts database). Runs the link flows when a mail provider
# is configured (RESEND_API_KEY/RESEND_API_URL), the documented fallback when
# not.
test-authflow:
	@cd web && node tests/authflow.test.mjs

# Password reset, session revocation and single-use links end to end in a real
# browser, own production server and fake mail/engine. Port 3484.
test-auth-transaction:
	@cd web && node tests/auth-transaction.test.mjs

# Full browser workflow against production routes and a fake engine: audit,
# FX landed cost, evidence save/export, approve, assign, PDF, mobile. Port 3482.
test-feature-journey:
	@cd web && node tests/feature-journey.test.mjs

# Captures outbound email locally so the link flows can be exercised without
# a provider account. Point RESEND_API_URL at it when starting the web app.
mailcatch:
	@cd web && node tests/mailcatch.mjs

# --- operations -------------------------------------------------------------
preflight:
	@python3 ops/preflight.py

backup:
	@python3 ops/backup-accounts.py

restore:
	@python3 ops/restore-accounts.py $(BACKUP)

install:
	@sudo ops/install.sh

diff:
	@curl -fsS -X POST http://127.0.0.1:3000/api/admin/diff \
	  -H "x-admin-token: $$HTSDESK_ADMIN_TOKEN" | python3 -m json.tool

email-preview:
	@curl -fsS "http://127.0.0.1:3000/api/admin/email-preview?account=$$ACCOUNT" \
	  -H "x-admin-token: $$HTSDESK_ADMIN_TOKEN" | python3 -c \
	  "import sys,json;d=json.load(sys.stdin);print(d['subject']);print();print(d['text'])"
