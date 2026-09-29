/** Reads a pasted or uploaded list of already-filed entries for Refund Check.
 *
 *  A separate reader from csvParse.ts's `parseCatalogue`, not an extension of
 *  it: that parser's `REQUIRED` columns (description/country/value) are
 *  shared module state used by the forward-looking audit CSV, and this flow
 *  needs entry_date and duty_paid to ALSO be required -- changing what's
 *  required there would change what an ordinary audit upload accepts. The
 *  genuinely generic, already-tested primitives (`parseRows` for delimiter/
 *  quote/BOM handling, `parseAmount` for currency strings) are reused
 *  directly; only the field set and per-row validation are new.
 *
 *  Same "never drop a row" philosophy as parseCatalogue: a row that cannot be
 *  fully read is still sent, flagged, so a customer sees every entry they
 *  pasted accounted for.
 */
import { parseAmount, parseRows } from "./csvParse";

export type RefundCheckRow = {
  row: number;
  sku: string;
  description: string;
  country: string;
  value: number;
  rawValue: string;
  entryHts: string | null;
  /** ISO yyyy-mm-dd, or null when unreadable. */
  entryDate: string | null;
  rawEntryDate: string;
  dutyPaid: number;
  rawDutyPaid: string;
  /** ISO yyyy-mm-dd, or null when absent or unreadable -- absence is not an
   *  error, an unreadable value is. */
  liquidationDate: string | null;
  rawLiquidationDate: string;
  problems: string[];
};

type Field = "sku" | "description" | "country" | "value" | "entryHts" | "entryDate" | "dutyPaid" | "liquidationDate";

const REQUIRED: Field[] = ["description", "country", "value", "entryDate", "dutyPaid"];

const ALIASES: Record<Field, string[]> = {
  sku: ["sku", "part number", "part no", "item number", "item no", "product code", "style"],
  description: ["description", "desc", "product", "product description", "item description", "goods"],
  country: ["country", "origin", "country of origin", "coo", "origin country"],
  value: ["value", "entered value", "customs value", "amount", "total value"],
  entryHts: ["hts", "entry hts", "hts code", "htsus", "tariff code", "declared hts", "declared code"],
  entryDate: ["entry date", "date of entry", "import date", "date entered"],
  dutyPaid: ["duty paid", "duty", "amount paid", "duty amount", "paid duty"],
  liquidationDate: ["liquidation date", "date of liquidation", "liquidated"],
};

const FIELD_LABEL: Record<Field, string> = {
  sku: "sku", description: "description", country: "country", value: "entered value",
  entryHts: "hts", entryDate: "entry date", dutyPaid: "duty paid", liquidationDate: "liquidation date",
};

const MAX_LEN = { sku: 64, description: 2000, country: 2000, entryHts: 200 };

export const TEMPLATE_CSV =
  "sku,description,country,value,hts,entry date,duty paid,liquidation date\r\n"
  + "TS-001,mens knitted cotton t-shirt short sleeve,China,48000,6109.10.00.12,2026-01-15,1650.00,\r\n"
  + "MG-09,ceramic coffee mug,Germany,12000,6912.00.44.00,2025-11-02,890.00,2026-08-20\r\n";

export const EXPECTED_FORMAT =
  "One entry per row. description, country, entered value, entry date and duty paid are required; "
  + "sku, hts and liquidation date are optional. Dates read as yyyy-mm-dd or mm/dd/yyyy. Give a "
  + "liquidation date if you know it, for an exact protest deadline instead of an estimate.";

function normHeader(h: string): string {
  return h.toLowerCase().replace(/\([^)]*\)/g, " ").replace(/[_\-./:]+/g, " ").replace(/\s+/g, " ").trim();
}

/** yyyy-mm-dd or mm/dd/yyyy (also m/d/yy) only -- conservative on purpose,
 *  matching parseAmount's refusal to guess at an ambiguous format. Returns
 *  null, never a best-effort guess, for anything else. */
export function parseEntryDate(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);
  let y: number, mo: number, d: number;
  if (iso) { y = Number(iso[1]); mo = Number(iso[2]); d = Number(iso[3]); }
  else if (us) {
    mo = Number(us[1]); d = Number(us[2]);
    y = Number(us[3]); if (y < 100) y += y < 70 ? 2000 : 1900;
  } else return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

export type ParseResult =
  | { ok: true; items: RefundCheckRow[]; incomplete: number; ignored: string[] }
  | { ok: false; problems: string[] };

export function parseRefundCheckCsv(text: string): ParseResult {
  const rows = parseRows(text).filter((r) => r.some((c) => c.trim()));
  if (!rows.length) return { ok: false, problems: ["There is nothing to check yet. Paste your entries or upload a CSV."] };

  const [head, ...body] = rows;
  const seen = new Map<Field, string[]>();
  const columns = new Map<Field, number>();
  const ignored: string[] = [];

  head.forEach((h, i) => {
    const norm = normHeader(h);
    const field = (Object.keys(ALIASES) as Field[]).find((f) => ALIASES[f].includes(norm));
    if (!field) { if (h.trim()) ignored.push(h.trim()); return; }
    seen.set(field, [...(seen.get(field) ?? []), h.trim()]);
    if (!columns.has(field)) columns.set(field, i);
  });

  const problems: string[] = [];
  for (const f of REQUIRED) {
    if (!columns.has(f)) {
      problems.push(`Missing the "${FIELD_LABEL[f]}" column. Accepted headings: ${ALIASES[f].slice(0, 4).join(", ")}.`);
    }
  }
  for (const [f, names] of seen) {
    if (names.length > 1) {
      problems.push(`The "${FIELD_LABEL[f]}" column appears more than once (${names.map((n) => `"${n}"`).join(", ")}). Keep one.`);
    }
  }
  if (problems.length) return { ok: false, problems };
  if (!body.length) return { ok: false, problems: ["The header is there but there are no entry rows under it."] };

  const cell = (r: string[], f: Field) => (columns.has(f) ? (r[columns.get(f)!] ?? "").trim() : "");

  let incomplete = 0;
  const items: RefundCheckRow[] = body.map((r, i) => {
    const problemsHere: string[] = [];
    const limited = (f: Field, max: number) => {
      const v = cell(r, f);
      if (v.length <= max) return v;
      problemsHere.push(`${FIELD_LABEL[f]} shortened to ${max} characters`);
      return v.slice(0, max);
    };
    const description = limited("description", MAX_LEN.description);
    const country = limited("country", MAX_LEN.country);
    const rawValue = cell(r, "value");
    const value = parseAmount(rawValue);
    const entryHts = limited("entryHts", MAX_LEN.entryHts);
    const sku = limited("sku", MAX_LEN.sku);

    const rawEntryDate = cell(r, "entryDate");
    const entryDate = parseEntryDate(rawEntryDate);
    const rawDutyPaid = cell(r, "dutyPaid");
    const dutyPaid = parseAmount(rawDutyPaid);
    const rawLiquidationDate = cell(r, "liquidationDate");
    const liquidationDate = rawLiquidationDate ? parseEntryDate(rawLiquidationDate) : null;

    if (!description && !entryHts) problemsHere.push("no description");
    if (!country) problemsHere.push("no country");
    if (value === null) problemsHere.push(rawValue ? "entered value not readable" : "no entered value");
    else if (value <= 0) problemsHere.push("entered value is not positive");
    if (!rawEntryDate) problemsHere.push("no entry date");
    else if (!entryDate) problemsHere.push("entry date not readable (use yyyy-mm-dd or mm/dd/yyyy)");
    if (!rawDutyPaid) problemsHere.push("no duty paid");
    else if (dutyPaid === null) problemsHere.push("duty paid not readable");
    else if (dutyPaid < 0) problemsHere.push("duty paid is negative");
    if (rawLiquidationDate && !liquidationDate) problemsHere.push("liquidation date not readable (use yyyy-mm-dd or mm/dd/yyyy)");

    if (problemsHere.length) incomplete += 1;
    return {
      row: i + 1, sku, description, country,
      value: value !== null && value > 0 ? value : 0, rawValue,
      entryHts: entryHts || null,
      entryDate, rawEntryDate,
      dutyPaid: dutyPaid !== null && dutyPaid >= 0 ? dutyPaid : 0, rawDutyPaid,
      liquidationDate, rawLiquidationDate,
      problems: problemsHere,
    };
  });
  return { ok: true, items, incomplete, ignored };
}
