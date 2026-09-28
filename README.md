# HTSDesk — duty & tariff intelligence for SMB importers

A duty-calculation and HTS-classification engine for the ~400,000 US businesses
that import goods and are ignored by enterprise trade platforms.

## Why this exists

It is not possible to compute a correct US duty figure from the USITC JSON feed
alone. 487 of 565 Chapter 99 trade-remedy rules carry **no machine-readable
product scope** — they delegate it to the Chapter 99 U.S. Notes, which USITC
publishes only as PDF prose. Tools built on the JSON alone are guessing.

This engine parses the Notes and resolves scope properly.

## Correctness features other calculators miss

| Feature | Why it matters |
|---|---|
| U.S. Notes scope extraction | Section 301 list membership lives only in the PDF notes |
| Suspension detection | `9903.88.16` is suspended; applying it overstates duty by 15pp |
| Directional code containment | ref `8471.49.10` does not cover `8471.30.01.00` despite sharing a heading |
| Inherited country scope | `9903.41.x` is Japan-only via a blank-code superior line |
| IEEPA segregation | struck down 2026-02-20; reported as refundable, not owed |
| Fail-closed on unknown scope | unresolved headings are flagged, never silently applied |

## Validation

Extracted Section 301 list sizes against published USTR figures:

| Heading | List | USTR | Extracted |
|---|---|---|---|
| 9903.88.01 | 1 | ~818 | 856 |
| 9903.88.02 | 2 | ~279 | 283 |
| 9903.88.03 | 3 | ~5,745 | 5,906 |
| 9903.88.15 | 4A | ~3,200 | 2,958 |

## Layout

    core/ch99.py    Chapter 99 rate-line parser (100% pattern coverage)
    core/hts.py     HTS tree with rate inheritance
    core/duty.py    duty stack resolver (base -> overlays -> MPF/HMF)
    core/engine.py  wiring
    ingest/notes.py Chapter 99 U.S. Notes scope extractor

## Data sources (all free, all public)

- USITC HTS REST export — 19,949 leaf codes
- USITC Chapter 99 PDF — the U.S. Notes
- CBP CROSS — 200,962 classification rulings, HTS-tagged (grows with routine ingest; re-check against `data/htsdesk.db` before quoting a figure)
- Federal Register API — live tariff actions

## Fee constants

FY2027, effective 2026-10-01: MPF 0.3464% (min $34.58, max $670.86), HMF 0.125%.
Inflation-adjusted annually — re-verify each October against `core/duty.py`'s
`MPF_MIN`/`MPF_MAX`, the source of truth (CBP Dec. 26-14, 91 FR 48398).
