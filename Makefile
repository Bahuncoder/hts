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

build:
	cd web && npm run build

# --- verify -----------------------------------------------------------------
test: test-duty test-api

test-duty:
	@python3 tests/test_duty.py

test-api:
	@python3 tests/test_api.py

eval:
	python3 tests/eval_classify.py 400

check: build test-duty test-api eval
