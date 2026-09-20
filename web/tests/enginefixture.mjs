/** Stand-in engine responses for the code page, calculator and home, following
 *  the shapes in src/lib/api.ts. Used with tests/auditfixture.mjs (the audit).
 *
 *  The code page fixture is deliberately awkward in the way real data is: the
 *  line's own description is a fragment ("Men's (338)"), the quote is
 *  incomplete, and the trade remedies mix ones that name the requested origin
 *  with one that names only Canada.
 */
export const FRAGMENT_PATH =
  "T-shirts, singlets, tank tops and similar garments, knitted or crocheted: > Of cotton > Men's or boys': > Other T-shirts: > Men's (338)";

const component = (label, rate_pct, amount, authority) =>
  ({ label, rate_pct, amount, basis: "ad valorem", authority });

export function quoteFixture({ hts = "6109.10.00.12", country = "China", value = 10000, refundable = 750 } = {}) {
  const components = [
    component("MFN duty", 16.5, value * 0.165, "HTSUS Column 1 General"),
    component("Section 301 (List 3)", 25, value * 0.25, "9903.88.03"),
    component("Merchandise Processing Fee", 0.3464, 34.64, "19 CFR 24.23"),
    component("Harbor Maintenance Fee", 0.125, value * 0.00125, "26 U.S.C. 4461"),
  ];
  const total = components.reduce((a, c) => a + c.amount, 0);
  return {
    hts, country, country_code: "CN", entered_value: value, components,
    total_duty: total, effective_rate_pct: Math.round((total / value) * 10000) / 100,
    landed_cost: value + total,
    refundable: refundable ? [component("IEEPA fentanyl", 10, refundable, "9903.01.24")] : [],
    refundable_amount: refundable,
    warnings: ["One trade-remedy heading covers this origin but its product scope is not verified."],
    scope_unverified: ["9903.05.31"], incomplete: ["specific_duty_omitted"], complete: false,
    dataset_revision: "test-rev-1",
  };
}

const remedy = (heading, countries, applies, extra = {}) => ({
  heading, countries: JSON.stringify(countries), note: "20(a)", effective_from: "2025-03-04",
  rate_pct: 25, raw_rate: "25%", suspended: 0, applies_to_origin: applies, ...extra,
});

export function htsFixture(code, country = "China", value = 10000) {
  return {
    hts: code, description: "Men's (338)", full_path: FRAGMENT_PATH, chapter: "61", is_leaf: true,
    rates: { general: "16.5%", special: "", other: "90%" }, units: ["doz.", "kg"],
    quote: quoteFixture({ hts: code, country, value }),
    rulings: [{ ruling_number: "N123456", subject: "Men's cotton T-shirt", ruling_date: "2020-01-01",
      revoked: 0, url: "https://rulings.cbp.gov/ruling/N123456" }],
    trade_remedies: [
      remedy("9903.88.03", ["China"], true),
      remedy("9903.01.24", ["China", "Hong Kong"], true, { suspended: 1 }),
      remedy("9903.01.10", ["Canada"], false, { raw_rate: "50%" }),
      remedy("9903.01.32", ["Mexico"], false),
    ],
  };
}

export const HEALTH_WITH_COUNTS = { status: "ok", hts_edition: "fixture",
  counts: { hts: 19949, ruling: 200962, ch99_rule: 565, ch99_scope: 12362 } };
export const HEALTH_WITHOUT_COUNTS = { status: "ok", hts_edition: "fixture" };
