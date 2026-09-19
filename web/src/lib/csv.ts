/** CSV emitter for audit results and saved catalogues.
 *
 *  Quotes every field: HTS descriptions routinely contain commas, and a
 *  spreadsheet that silently shifts a column is worse than no export. Excel
 *  needs CRLF and a BOM to read UTF-8 correctly.
 */
import { LEGACY_LABEL, STATUS_LABEL, reviewNotes, type Status } from "./auditModel";

export type CsvRow = Record<string, string | number | null | undefined>;

// A field a spreadsheet would treat as a formula. Quoting alone does not help:
// Excel and Sheets parse the cell *after* unquoting, so `"=cmd|'/C calc'!A1"`
// still executes on open. Product descriptions are attacker-controlled and
// these files get sent to brokers, so the leading character is neutralised.
const FORMULA_LEAD = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

function cell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '""';
  let s = String(v);
  // A negative number is not a formula; prefixing it would corrupt the figure.
  if (FORMULA_LEAD.test(s) && !PLAIN_NUMBER.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function toCsv(rows: CsvRow[], columns: { key: string; label: string }[]): string {
  const head = columns.map((c) => cell(c.label)).join(",");
  const body = rows.map((r) => columns.map((c) => cell(r[c.key])).join(","));
  return "﻿" + [head, ...body].join("\r\n") + "\r\n";
}

export const AUDIT_COLUMNS = [
  { key: "row", label: "Row" },
  { key: "sku", label: "SKU" },
  { key: "description", label: "Description" },
  { key: "country", label: "Country of origin" },
  { key: "hts", label: "HTS code" },
  { key: "status", label: "Status" },
  { key: "review_notes", label: "Review notes" },
  { key: "confidence", label: "Confidence" },
  { key: "entered_value", label: "Entered value (USD)" },
  { key: "duty", label: "Line duty and HMF, excl. MPF (USD)" },
  { key: "effective_rate_pct", label: "Effective rate (%)" },
  { key: "refundable", label: "Potentially refundable (USD)" },
];

type ExportLine = {
  row?: number | null;
  sku?: string | null;
  description: string;
  country: string;
  hts?: string | null;
  /** null for a row saved before statuses existed. */
  status: Status | null;
  error?: string | null;
  review_reasons?: string[] | null;
  warnings?: string[] | null;
  incomplete?: string[] | null;
  confidence?: string | null;
  entered_value?: number | null;
  duty?: number | null;
  effective_rate_pct?: number | null;
  refundable?: number | null;
};

const fixed = (n: number | null | undefined) =>
  typeof n === "number" && Number.isFinite(n) ? n.toFixed(2) : "";

/** One export row, for both the audit page's download and the saved-catalogue
 *  export, so the two cannot drift apart. Unresolved lines are exported with
 *  their status and reasons, and blank figures rather than zeros. */
export function auditExportRow(l: ExportLine): CsvRow {
  return {
    row: l.row ?? "",
    sku: l.sku ?? "",
    description: l.description,
    country: l.country,
    hts: l.hts ?? "",
    status: l.status ? STATUS_LABEL[l.status] : LEGACY_LABEL,
    review_notes: reviewNotes(l).join(" | "),
    confidence: l.confidence ?? "",
    entered_value: fixed(l.entered_value),
    duty: fixed(l.duty),
    effective_rate_pct: fixed(l.effective_rate_pct),
    refundable: fixed(l.refundable),
  };
}

export function csvFilename(base: string): string {
  const stamp = new Date().toISOString().slice(0, 10);
  const safe = base.replace(/[^a-z0-9-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
  return `${safe || "catalogue"}-${stamp}.csv`;
}
