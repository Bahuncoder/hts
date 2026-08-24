# Build status

## Done
- Chapter 99 rate-line parser — 565/565 lines, 0 misparsed
- HTS tree + rate inheritance — 19,949 leaf codes
- U.S. Notes scope extractor — 67 headings, 10,982 product codes
- Duty stack resolver — base + overlays + MPF/HMF, fully cited
- IEEPA refund segregation

## Next
1. CROSS ingest (221,616 rulings) -> Postgres + full-text index
2. Classifier: retrieval over rulings + GRI reasoning (Claude)
3. Federal Register poller -> change alerts
4. FastAPI service + Next.js app
5. Catalog upload -> portfolio audit -> defensible binder export
6. Programmatic SEO: /hts/{code}, /tariff/{country}/{chapter}, /changes

## Known gaps
- ~78 remedy headings still unscoped (notes use prose, not enumeration)
- Note 20(s)(ii)-style "described in" scope needs LLM interpretation
- Specific/compound duties (cents/kg) need quantity data
- Suspension detection covers footnote-declared cases only
- AD/CVD orders not yet integrated (separate CBP dataset)
