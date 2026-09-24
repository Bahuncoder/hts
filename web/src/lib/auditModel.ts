/** What an audited line is, shared by the audit page, the save action, the
 *  saved-catalogue pages and the CSV export.
 *
 *  Pure and dependency-free on purpose: it runs in the browser, in server
 *  actions and in route handlers, and it is loaded directly by the tests.
 *
 *  The engine assigns every line exactly one status. `ready` is the only one
 *  that means "priced, complete and nothing to confirm"; everything else is
 *  unresolved work, and counts are always taken as a partition of the lines so
 *  they cannot overlap or fall short of the number submitted.
 */

import { projectEvidence, type EvidenceSnapshot } from "./evidence";

export const STATUSES = [
  "error", "unclassified", "not_processed",
  "incomplete", "scope_review", "suffix_review", "low_confidence",
  "ready",
] as const;
export type Status = (typeof STATUSES)[number];

/** Priced lines carry numbers; the rest carry none. */
export const PRICED_STATUSES: readonly Status[] =
  ["incomplete", "scope_review", "suffix_review", "low_confidence", "ready"];
/** Priced, but something must be confirmed before the number is relied on. */
export const REVIEW_STATUSES: readonly Status[] =
  ["incomplete", "scope_review", "suffix_review", "low_confidence"];
/** No numbers at all: the product could not be priced. */
export const FAILED_STATUSES: readonly Status[] =
  ["error", "unclassified", "not_processed"];

/** Text, never colour alone. */
export const STATUS_LABEL: Record<Status, string> = {
  error: "Error",
  unclassified: "Not classified",
  not_processed: "Not processed",
  incomplete: "Incomplete",
  scope_review: "Scope review",
  suffix_review: "Confirm code",
  low_confidence: "Low confidence",
  ready: "Ready",
};

/** Shown for rows saved before statuses were recorded. */
export const LEGACY_LABEL = "Saved before review states existed";

export type Candidate = {
  hts: string;
  description?: string;
  full_path?: string;
  general_rate?: string;
  score?: number;
  ruling_support?: number;
  confidence?: string;
  reasoning?: string;
  rulings?: { ruling: string; subject?: string; date?: string; revoked?: boolean; url?: string }[];
};

export type Alternative = { hts: string; description?: string; general_rate?: string };

export type AuditLine = {
  evidence?: EvidenceSnapshot;
  row: number;
  sku: string;
  description: string;
  country: string;
  hts: string | null;
  status: Status;
  error_code?: string;
  error?: string;
  confidence?: string;
  entered_value?: number;
  duty?: number;
  effective_rate_pct?: number;
  refundable?: number;
  warnings?: string[];
  incomplete?: string[];
  review_reasons?: string[];
  scope_unverified?: string[];
  suggested?: Candidate[];
  alternatives?: Alternative[];
  /** The facts a caller stated for this line (quantity for a per-unit duty,
   *  the claimed preference program, Section 232 facts). The engine's own
   *  response never echoes these back — it only returns what they produced
   *  — so the proxy merges them in from the request before signing. Kept on
   *  the saved line so a re-price can use the SAME stated facts against
   *  current rates, rather than silently reverting every re-priced line to
   *  "not claimed" and reporting that as a rate change. */
  quantity?: number;
  quantity_unit?: string;
  preference_program?: string;
  end_use?: string;
  metal_weight_pct?: number;
  vehicle_use?: string;
};

/** A line as it is signed and saved: everything except the classifier's
 *  candidate lists, which are for reviewing on screen and are large. */
export type SavedLine = Omit<AuditLine, "suggested" | "alternatives">;

export const isStatus = (s: unknown): s is Status =>
  typeof s === "string" && (STATUSES as readonly string[]).includes(s);

export const isPriced = (s: Status) => (PRICED_STATUSES as readonly string[]).includes(s);
export const isFailed = (s: Status) => (FAILED_STATUSES as readonly string[]).includes(s);

/** ready | review | failed. */
export type Bucket = "ready" | "review" | "failed";
export const bucketOf = (s: Status): Bucket =>
  s === "ready" ? "ready" : isFailed(s) ? "failed" : "review";

export type Counts = {
  submitted: number; ready: number; review: number; failed: number;
  /** Every non-ready line: review + failed. */
  unresolved: number;
  byStatus: Record<Status, number>;
};

/** Counts taken from the lines themselves, so ready + review + failed always
 *  equals what was submitted. */
export function countLines(lines: { status: Status }[]): Counts {
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<Status, number>;
  for (const l of lines) byStatus[l.status] += 1;
  const ready = byStatus.ready;
  const failed = FAILED_STATUSES.reduce((n, s) => n + byStatus[s], 0);
  const review = REVIEW_STATUSES.reduce((n, s) => n + byStatus[s], 0);
  return { submitted: lines.length, ready, review, failed, unresolved: review + failed, byStatus };
}

/** Reasons a person should read, once each. The engine repeats a message in
 *  both `error` and `review_reasons`. */
export function reviewNotes(l: {
  error?: string | null; review_reasons?: string[] | null;
  warnings?: string[] | null; incomplete?: string[] | null;
}): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of [l.error, ...(l.review_reasons ?? []), ...(l.incomplete ?? []), ...(l.warnings ?? [])]) {
    const s = (t ?? "").trim();
    if (s && !seen.has(s)) { seen.add(s); out.push(s); }
  }
  return out;
}

// --- projection ---------------------------------------------------------------

const MAX_STR = 2000;
const MAX_LIST = 50;

const str = (v: unknown, max = MAX_STR): string | undefined =>
  typeof v === "string" ? v.slice(0, max) : undefined;
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
const strList = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((x) => typeof x === "string")
    ? v.slice(0, MAX_LIST).map((x: string) => x.slice(0, MAX_STR))
    : undefined;

/** Keeps only the fields that are signed and saved, with their types checked.
 *
 *  Both ends apply it: the audit proxy signs the projection of what the engine
 *  returned, and the save action projects whatever the browser sent before it
 *  checks the signature. So an extra or ill-typed field cannot ride along into
 *  the database, and the browser need not upload the candidate lists.
 *
 *  Returns null for something that is not a line (unknown status, no
 *  integer row), which makes the whole payload unverifiable. */
export function projectLine(x: unknown): SavedLine | null {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return null;
  const r = x as Record<string, unknown>;
  if (!isStatus(r.status)) return null;
  if (typeof r.row !== "number" || !Number.isInteger(r.row) || r.row < 0) return null;

  const hts = r.hts === null || r.hts === undefined ? null : str(r.hts, 40);
  if (hts === undefined) return null;

  const line: SavedLine = {
    row: r.row,
    sku: str(r.sku, 200) ?? "",
    description: str(r.description, 4000) ?? "",
    country: str(r.country, 200) ?? "",
    hts,
    status: r.status,
  };
  const set = <K extends keyof SavedLine>(k: K, v: SavedLine[K] | undefined) => {
    if (v !== undefined) line[k] = v;
  };
  set("error_code", str(r.error_code, 80));
  set("error", str(r.error));
  set("confidence", str(r.confidence, 40));
  set("entered_value", num(r.entered_value));
  set("duty", num(r.duty));
  set("effective_rate_pct", num(r.effective_rate_pct));
  set("refundable", num(r.refundable));
  set("warnings", strList(r.warnings));
  set("incomplete", strList(r.incomplete));
  set("review_reasons", strList(r.review_reasons));
  set("scope_unverified", strList(r.scope_unverified));
  set("quantity", num(r.quantity));
  set("quantity_unit", str(r.quantity_unit, 32));
  set("preference_program", str(r.preference_program, 8));
  set("end_use", str(r.end_use, 32));
  set("metal_weight_pct", num(r.metal_weight_pct));
  set("vehicle_use", str(r.vehicle_use, 32));
  const snapshot = r.evidence ?? (Array.isArray(r.suggested)
    ? r.suggested[0] ?? { source: "no_classifier_evidence" } : undefined);
  set("evidence", projectEvidence(snapshot));
  return line;
}

/** JSON with object keys sorted at every depth, so the same value always
 *  serialises to the same bytes wherever it was built. `undefined` members are
 *  dropped, as JSON.stringify would drop them. */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(sortKeys(v));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => [k, sortKeys(o[k])]),
    );
  }
  return v;
}

/** The parts of an audit that are signed and, once verified, saved. */
export type SignedAudit = {
  v: 1;
  /** ISO time the engine's answer was received. */
  at: string;
  dataset_revision: string;
  assumptions: string[];
  /** Entry-level Merchandise Processing Fee. Line duty excludes it. */
  mpf: number;
  /** The two request-level inputs the entry-level fee and the Harbor
   *  Maintenance Fee rest on. The engine's own response never echoes these
   *  back (they only affect its output, via mpf/warnings), so — like a
   *  line's own facts — the proxy merges them in from the request before
   *  signing. Recorded so a re-price resubmits the same shipment terms
   *  instead of silently defaulting back to one entry by vessel. */
  entries: number;
  by_vessel: boolean;
  lines: SavedLine[];
};

/** Money figures for a set of lines, from the lines and the entry-level fee.
 *  Only priced lines carry numbers. */
export function totalsOf(
  lines: Pick<SavedLine, "status" | "entered_value" | "duty" | "refundable">[], mpf: number,
) {
  let value = 0, duty = 0, refundable = 0;
  for (const l of lines) {
    if (!isPriced(l.status)) continue;
    value += l.entered_value ?? 0;
    duty += l.duty ?? 0;
    refundable += l.refundable ?? 0;
  }
  const total = duty + mpf;
  return {
    value, duty: total, lineDuty: duty, mpf, refundable,
    ratePct: value > 0 ? (total / value) * 100 : 0,
  };
}
