/** A stand-in engine /api/audit that follows the real contract, driven by
 *  keywords in the description so a test can ask for any mix of states:
 *
 *    "ready" "scope" "suffix" "lowconf" "incomplete" -> that status (priced)
 *    "noclass"                                       -> unclassified
 *    value <= 0                                      -> error (invalid_value)
 *    country "Chnia"                                 -> error (invalid_country)
 *    "slow"                                          -> waits, then answers
 *    otherwise                                       -> ready
 *
 *  Every submitted item comes back, in order, with its `row` echoed (else the
 *  1-based index), exactly as the engine does.
 */
export const STATUS_KEYS = ["error", "unclassified", "not_processed", "incomplete",
  "scope_review", "suffix_review", "low_confidence", "ready"];
const PRICED = new Set(["incomplete", "scope_review", "suffix_review", "low_confidence", "ready"]);

const candidate = (hts) => ({
  hts, description: `Candidate ${hts}`, full_path: `Chapter > ${hts}`, general_rate: "",
  score: 0.91, ruling_support: 12, confidence: "high", reasoning: "",
  rulings: [{ ruling: "N123456", subject: "Ruling subject", date: "2020-01-01", revoked: false,
    url: "https://rulings.cbp.gov/ruling/N123456" }],
});

export function auditResponse(body, { revision = "test-rev-1" } = {}) {
  const lines = body.items.map((it, idx) => {
    const d = String(it.description ?? "").toLowerCase();
    const base = { row: it.row ?? idx + 1, sku: it.sku ?? "", description: it.description ?? "",
      country: it.country ?? "", hts: it.hts || null };
    const refuse = (status, code, error) => ({ ...base, status, error_code: code, error,
      review_reasons: [error], warnings: [], incomplete: [], scope_unverified: [],
      suggested: [], alternatives: [] });

    if (!(it.value > 0)) return refuse("error", "invalid_value", "Entered value must be a positive amount.");
    if (it.country === "Chnia") return refuse("error", "invalid_country",
      "Unrecognised country of origin 'Chnia'. Use the country name or its ISO code (for example China or CN).");
    if (d.includes("noclass")) return refuse("unclassified", "no_candidate",
      "Could not classify this product from its description.");

    let status = "ready";
    for (const k of ["scope", "suffix", "lowconf", "incomplete"]) {
      if (d.includes(k)) status = { scope: "scope_review", suffix: "suffix_review",
        lowconf: "low_confidence", incomplete: "incomplete" }[k];
    }
    const hts = it.hts || "6109.10.00.12";
    const duty = Math.round(it.value * 0.165 * 100) / 100;
    const reasons = {
      scope_review: ["1 trade-remedy heading(s) cover this origin and need scope verification."],
      suffix_review: ["Sibling statistical lines carry different rates; the 10-digit suffix was not determined."],
      low_confidence: ["Low-confidence classification."],
      incomplete: ["The duty is understated: a quantity-based rate could not be applied"],
      ready: [],
    }[status];
    return { ...base, hts, confidence: status === "low_confidence" ? "low" : "high", status,
      review_reasons: reasons,
      warnings: status === "scope_review" ? ["1 trade-remedy heading(s) cover China but are excluded pending scope verification."] : [],
      incomplete: status === "incomplete" ? ["a quantity-based rate could not be applied"] : [],
      entered_value: it.value, duty, effective_rate_pct: 16.5, refundable: status === "ready" ? 0 : 5,
      scope_unverified: status === "scope_review" ? ["9903.05.31"] : [],
      suggested: it.hts ? [] : [candidate(hts), candidate("6109.10.00.07")],
      alternatives: status === "suffix_review" ? [{ hts: "6109.10.00.04", description: "Sibling line", general_rate: "16.5%" }] : [] };
  });

  const by_status = Object.fromEntries(STATUS_KEYS.map((s) => [s, lines.filter((l) => l.status === s).length]));
  const priced = lines.filter((l) => PRICED.has(l.status));
  const sum = (k) => Math.round(priced.reduce((a, l) => a + (l[k] ?? 0), 0) * 100) / 100;
  const value = sum("entered_value");
  const mpf = value > 0 ? 33.58 * (body.entries ?? 1) : 0;
  const unresolved = lines.length - by_status.ready;
  return {
    summary: {
      submitted: lines.length, items: lines.length, processed: lines.length, priced: priced.length,
      unresolved, by_status, truncated: false, totals_complete: unresolved === 0,
      entered_value: value, duty_and_hmf: sum("duty"), mpf, duty: Math.round((sum("duty") + mpf) * 100) / 100,
      effective_rate_pct: value ? Math.round(((sum("duty") + mpf) / value) * 10000) / 100 : 0,
      potentially_refundable: sum("refundable"),
      unclassified: by_status.unclassified, needs_scope_review: by_status.scope_review,
      assumptions: [
        `The priced value is spread over ${body.entries ?? 1} formal ${(body.entries ?? 1) === 1 ? "entry" : "entries"}; the Merchandise Processing Fee minimum and maximum apply to each entry.`,
        body.by_vessel === false ? "Non-vessel shipment: no Harbor Maintenance Fee."
          : "Vessel shipment assumed: Harbor Maintenance Fee applied.",
      ],
      dataset_revision: revision,
    },
    lines,
  };
}
