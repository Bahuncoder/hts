.PHONY: help data refresh rulings fedreg api web build test test-duty test-api eval check \
        preflight backup restore install mailcatch diff email-preview

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
	@echo "  make test-billing / test-diff / test-outbox / test-audit / test-migrate"
	@echo "  make test-csvparse / test-proof / test-review"
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
test: test-duty test-classify-eval test-refresh test-api test-billing test-email test-diff \
      test-outbox test-audit test-migrate test-csvparse test-proof test-review

test-duty:
	@python3 tests/test_duty.py

test-api:
	@python3 tests/test_api.py

test-refresh:
	@python3 tests/test_refresh.py

test-classify-eval:
	@python3 tests/test_classify_eval.py

eval:
	python3 tests/eval_classify.py 400

check: build test-duty test-classify-eval test-refresh test-api test-billing test-email \
       test-diff test-outbox test-audit test-migrate test-csvparse test-proof test-review test-journey test-security test-authflow eval

test-billing:
	@cd web && node tests/billing.test.mjs

test-email:
	@cd web && node tests/email.test.mjs

# These start their own production server on a spare port (3200-3205) with a
# scratch accounts database and fake Stripe/engine/mail servers, rebuilding
# first if the bundle is stale. They never touch data/accounts.db.
test-diff:
	@cd web && node tests/diff.test.mjs

test-outbox:
	@cd web && node tests/outbox.test.mjs

test-audit:
	@cd web && node tests/audit.test.mjs

test-migrate:
	@cd web && node tests/migrate.test.mjs

# The catalogue reader and shared row model, straight from src/lib (no server).
test-csvparse:
	@cd web && node tests/csvparse.test.mjs

# Saved audits are server-signed: the proxy signs, saving verifies.
test-proof:
	@cd web && node tests/proof.test.mjs

# The audit as a review workspace and honest saved catalogues, in a real
# browser against its own production server (3311/3312) and a fake engine.
test-review:
	@cd web && node tests/review.test.mjs

# Drives a real browser through the customer journey. Needs the API and web
# app running, and a Chrome on the machine.
test-journey:
	@cd web && node tests/journey.test.mjs

# Attacks the running app: cross-account access, session flags, credential
# throttling, CSV formula injection, admin gates.
test-security:
	@cd web && node tests/security.test.mjs

# Password reset and email verification. Runs the link flows when a mail
# provider is configured, the documented fallback when not.
test-authflow:
	@cd web && node tests/authflow.test.mjs

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
