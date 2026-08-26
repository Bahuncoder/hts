.PHONY: help data refresh rulings fedreg api web build test test-duty test-api eval check

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
	@echo "  make eval       held-out classifier accuracy"
	@echo ""
	@echo "Jobs"
	@echo "  make diff       match new tariff actions against watched codes"
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
	python3 -m uvicorn api.main:app --host 127.0.0.1 --port 8099 --reload

web:
	cd web && npm run dev

# Next persists prerendered pages and ISR output under .next. An incremental
# build reuses them, so an edit to page copy can compile successfully and
# still serve the previous text. Clear it.
build:
	cd web && rm -rf .next && npm run build

# --- verify -----------------------------------------------------------------
test: test-duty test-api test-billing test-catalogues

test-duty:
	@python3 tests/test_duty.py

test-api:
	@python3 tests/test_api.py

eval:
	python3 tests/eval_classify.py 400

check: build test-duty test-api test-billing test-catalogues eval

test-billing:
	@cd web && node tests/billing.test.mjs

test-catalogues:
	@cd web && node tests/catalogues.test.mjs

diff:
	@curl -fsS -X POST http://127.0.0.1:3000/api/admin/diff \
	  -H "x-admin-token: $$HTSDESK_ADMIN_TOKEN" | python3 -m json.tool
