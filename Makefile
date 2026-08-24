.PHONY: help data api web build eval refresh test

help:
	@echo "make data     rebuild reference database from local sources"
	@echo "make refresh  re-download HTS + notes + Federal Register, then rebuild"
	@echo "make api      run the API on :8099"
	@echo "make web      run the Next.js app on :3000"
	@echo "make eval     held-out classifier accuracy"
	@echo "make rulings  resume CROSS ruling body ingest"

data:
	python3 ingest/build.py

refresh:
	python3 ingest/refresh.py

api:
	python3 -m uvicorn api.main:app --host 127.0.0.1 --port 8099 --reload

web:
	cd web && npm run dev

eval:
	python3 tests/eval_classify.py 400

rulings:
	python3 ingest/cross.py --skip-metadata --bodies 60000 --concurrency 6
