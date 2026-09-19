/** Reads a pasted or uploaded catalogue into rows for the audit.
 *
 *  The one rule that matters: nothing is dropped. Every data row is kept with
 *  its original position, and a row that cannot be understood is sent anyway
 *  (amount 0), so the server reports it as an error the customer can read
 *  instead of it quietly vanishing and the totals understating exposure.
 *
 *  Pure, so it runs in the browser and is loaded directly by the tests.
 */

export type ParsedItem = {
  /** 1-based position among the data rows: header excluded, blank lines
   *  skipped, file order. */
  row: number;
  sku: string;
  description: string;
  country: string;
  /** 0 when the amount could not be read; the server rejects it with a message. */
  value: number;
  /** What the cell said, for the on-screen row when it could not be read. */
  rawValue: string;
  hts: string | null;
  /** Why this row looks incomplete before it is sent (informational only). */
  problems: string[];
};

export type Field = "sku" | "description" | "country" | "value" | "hts";

export const REQUIRED: Field[] = ["description", "country", "value"];

/** Header spellings accepted for each column, after normalising. The export's
 *  own headers are included so a downloaded file can be re-uploaded. */
export const ALIASES: Record<Field, string[]> = {
  description: ["description", "desc", "product", "product description", "item description", "goods", "goods description"],
  country: ["country", "origin", "country of origin", "coo", "origin country", "country of manufacture"],
  value: ["value", "amount", "entered value", "price", "total value", "total", "customs value"],
  sku: ["sku", "part number", "part no", "item number", "item no", "product code", "style"],
  hts: ["hts", "hts code", "htsus", "hs", "hs code", "tariff code", "tariff", "hts number"],
};

export const FIELD_LABEL: Record<Field, string> = {
  description: "description",
  country: "country",
  value: "value",
  sku: "sku",
  hts: "hts",
};

/** The engine's per-field limits. One over-long field makes it reject the
 *  entire request, so these are enforced before sending. */
const MAX_LEN = { sku: 64, description: 2000, country: 2000, hts: 200 };

export const TEMPLATE_CSV =
  "sku,description,country,value,hts\r\n" +
  "TS-001,mens knitted cotton t-shirt short sleeve,China,48000,\r\n" +
  "MG-09,ceramic coffee mug,Germany,12000,6912.00.44.00\r\n";

export const SAMPLE_CSV = `sku,description,country,value,hts
TS-001,mens knitted cotton t-shirt short sleeve,China,48000,
BP-220,nylon backpack with zipper closure,China,31000,
LI-20V,lithium-ion rechargeable battery pack 20V,Vietnam,75000,
CH-14,upholstered wooden dining chair,China,52000,
MG-09,ceramic coffee mug,Germany,12000,`;

export const EXPECTED_FORMAT =
  "One product per row. Columns: description, country (or origin) and value are required; " +
  "sku and hts are optional. Leave hts blank and it will be classified.";

function normHeader(h: string): string {
  return h
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")   // "Entered value (USD)"
    .replace(/[_\-./:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Splits text into rows of cells. Handles a BOM, quoted fields with embedded
 *  delimiters, newlines and doubled quotes, and CRLF / LF / lone CR line ends.
 *  The delimiter is comma, or tab when the header line is tab-separated (a
 *  paste from a spreadsheet), or semicolon likewise. */
export function parseRows(input: string): string[][] {
  const text = input.replace(/^﻿/, "");
  const delim = detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let cellStarted = false;

  const endCell = () => { row.push(cell); cell = ""; cellStarted = false; };
  const endRow = () => { endCell(); rows.push(row); row = []; };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && !cellStarted) { quoted = true; cellStarted = true; }
    else if (ch === delim) endCell();
    else if (ch === "\n") endRow();
    else if (ch === "\r") { if (text[i + 1] === "\n") i++; endRow(); }
    else { cell += ch; cellStarted = true; }
  }
  if (cell !== "" || cellStarted || row.length) endRow();
  return rows;
}

/** Looks at the first line only, outside quotes. */
function detectDelimiter(text: string): string {
  let quoted = false;
  const n: Record<string, number> = { ",": 0, "\t": 0, ";": 0 };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') { quoted = !quoted; continue; }
    if (quoted) continue;
    if (ch === "\n" || ch === "\r") break;
    if (ch in n) n[ch] += 1;
  }
  if (n["\t"] > n[","] && n["\t"] >= n[";"]) return "\t";
  if (n[";"] > n[","]) return ";";
  return ",";
}

/** A US-style amount: `1000`, `1,000.50`, `$1,000`, `USD 1 000`, `1000.5`.
 *  Returns null when it is not clearly one number, rather than guessing at
 *  European `1.000,50` or a range. */
export function parseAmount(raw: string): number | null {
  const s = raw.replace(/[\s ]/g, "").replace(/^(usd|us\$|\$)/i, "").replace(/(usd)$/i, "");
  if (!s) return null;
  const ok = /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s) || /^\d+(\.\d+)?$/.test(s) || /^\.\d+$/.test(s);
  if (!ok) return null;
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

export type Header = { field: Field; column: number; name: string };

export type ParseResult =
  | {
      ok: true;
      items: ParsedItem[];
      /** Data rows that look incomplete before sending; all are still sent. */
      incomplete: number;
      /** Headers present but not recognised, so the customer can see what was ignored. */
      ignored: string[];
    }
  | { ok: false; problems: string[] };

/** Reads the header, then every data row. Blocks (ok: false) only for a
 *  structural problem: a missing or ambiguous required column, or no data. */
export function parseCatalogue(text: string): ParseResult {
  const rows = parseRows(text).filter((r) => r.some((c) => c.trim()));
  if (!rows.length) return { ok: false, problems: ["There is nothing to audit yet. Paste your catalogue or upload a CSV."] };

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
      problems.push(`Missing the “${FIELD_LABEL[f]}” column. Accepted headings: ${ALIASES[f].slice(0, 4).join(", ")}.`);
    }
  }
  for (const [f, names] of seen) {
    if (names.length > 1) {
      problems.push(
        `The “${FIELD_LABEL[f]}” column appears more than once (${names.map((n) => `“${n}”`).join(", ")}). Keep one.`,
      );
    }
  }
  if (problems.length) return { ok: false, problems };
  if (!body.length) return { ok: false, problems: ["The header is there but there are no product rows under it."] };

  const cell = (r: string[], f: Field) => (columns.has(f) ? (r[columns.get(f)!] ?? "").trim() : "");

  let incomplete = 0;
  const items: ParsedItem[] = body.map((r, i) => {
    const problemsHere: string[] = [];
    // The engine rejects a whole request when one field exceeds its length
    // limit, which would drop every other row. Shorten and say so instead.
    const limited = (f: Field, max: number) => {
      const v = cell(r, f);
      if (v.length <= max) return v;
      problemsHere.push(`${FIELD_LABEL[f]} shortened to ${max} characters`);
      return v.slice(0, max);
    };
    const description = limited("description", MAX_LEN.description);
    const country = limited("country", MAX_LEN.country);
    const rawValue = cell(r, "value");
    const amount = parseAmount(rawValue);
    const hts = limited("hts", MAX_LEN.hts);
    const sku = limited("sku", MAX_LEN.sku);
    if (!description && !hts) problemsHere.push("no description");
    if (!country) problemsHere.push("no country");
    if (amount === null) problemsHere.push(rawValue ? "amount not readable" : "no amount");
    else if (amount <= 0) problemsHere.push("amount is not positive");
    if (problemsHere.length) incomplete += 1;
    return {
      row: i + 1,
      sku,
      description,
      country,
      value: amount !== null && amount > 0 ? amount : 0,
      rawValue,
      hts: hts || null,
      problems: problemsHere,
    };
  });
  return { ok: true, items, incomplete, ignored };
}
