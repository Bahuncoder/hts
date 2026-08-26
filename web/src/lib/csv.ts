/** CSV emitter for audit results and saved catalogues.
 *
 *  Quotes every field: HTS descriptions routinely contain commas, and a
 *  spreadsheet that silently shifts a column is worse than no export. Excel
 *  needs CRLF and a BOM to read UTF-8 correctly.
 */
export type CsvRow = Record<string, string | number | null | undefined>;

function cell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '""';
  const s = String(v);
  return `"${s.replace(/"/g, '""')}"`;
}

export function toCsv(rows: CsvRow[], columns: { key: string; label: string }[]): string {
  const head = columns.map((c) => cell(c.label)).join(",");
  const body = rows.map((r) => columns.map((c) => cell(r[c.key])).join(","));
  return "﻿" + [head, ...body].join("\r\n") + "\r\n";
}

export const AUDIT_COLUMNS = [
  { key: "sku", label: "SKU" },
  { key: "description", label: "Description" },
  { key: "country", label: "Country of origin" },
  { key: "hts", label: "HTS code" },
  { key: "confidence", label: "Confidence" },
  { key: "entered_value", label: "Entered value (USD)" },
  { key: "duty", label: "Duty and fees (USD)" },
  { key: "effective_rate_pct", label: "Effective rate (%)" },
  { key: "refundable", label: "Potentially refundable (USD)" },
  { key: "flags", label: "Flags" },
];

export function csvFilename(base: string): string {
  const stamp = new Date().toISOString().slice(0, 10);
  const safe = base.replace(/[^a-z0-9-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
  return `${safe || "catalogue"}-${stamp}.csv`;
}
