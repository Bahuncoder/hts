# Build status

## Working end to end

| Component | State |
|---|---|
| Chapter 99 rate-line parser | 565/565 lines, 0 misparsed |
| HTS tree + rate inheritance | 19,949 leaf codes |
| U.S. Notes scope extractor | 67 headings, 12,362 heading/code pairs |
| Duty stack resolver | base + remedies + MPF/HMF, every line cited |
| IEEPA segregation | struck-down duty reported as refundable |
| CROSS ingest | 200,962 rulings, 267,738 code links |
| Classifier | retrieval + optional GRI reasoning |
| Federal Register monitor | 1,364 actions, full-text HTS extraction |
| API | 10 endpoints |
| Web | 6 pages + 19,954-URL sitemap |

## Classifier accuracy (400 held-out CBP rulings)

| Metric | Retrieval only |
|---|---|
| top-1 heading (4-digit) | 58.2% |
| top-1 subheading (6-digit) | 46.2% |
| top-3 heading | 83.0% |

Measured across four runs while iterating. Heading-level precedent voting was
the one change that mattered, taking top-3 from 53% to 83%. Cleaning the ruling
subjects cost about 2.5 points of top-1 — the malformed subjects had been
carrying body text that happened to help matching — and scoring against ruling
bodies has so far been neutral, because only ~13% of bodies are loaded. Both
are worth re-measuring once the body ingest completes. Differences under about
2.5 points at n=400 are noise.

Retrieval recall ceiling is 99.5% — the correct heading is almost always among
the ruling votes, so ranking is where the remaining accuracy lives. The GRI
reasoning layer picks from the top-3 set, so 83.2% is the ceiling it works
against. That layer needs an API key and has not been measured yet.

## Known gaps

- Reasoning layer unmeasured (no API key set)
- ~78 remedy headings still unscoped: their notes describe goods in prose
  rather than enumerating codes, which needs the reasoning layer
- Specific and compound duties (cents/kg) need quantity data to be exact
- Suspension detection covers footnote-declared cases only
- AD/CVD orders not integrated (separate CBP dataset)
- Federal Register HTS extraction has occasional false positives from
  non-tariff numerics
- Ruling bodies still loading; accuracy should improve as coverage grows

## Not built

- Accounts, billing, saved catalogues (needs Postgres — SQLite is reference
  data only)
- Entry-summary (CBP 7501) ingest for the overpayment audit
- Duty drawback eligibility
- Change alerts wired to a customer catalogue
