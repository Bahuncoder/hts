/** The catalogue reader and the shared model, straight from the source.
 *
 *  The audit page's first duty is to lose nothing: every row must reach the
 *  engine with its position, and a header problem must be named. These load
 *  src/lib/csvParse.ts and src/lib/auditModel.ts themselves.
 *
 *  Run: node tests/csvparse.test.mjs   (no server needed)
 */
import assert from "node:assert/strict";
import { loadLib } from "./tsload.mjs";
import { suite } from "./harness.mjs";

const csv = await loadLib("csvParse");
const model = await loadLib("auditModel");
const out = await loadLib("csv");
const { check, finish } = suite();

const ok = (text) => {
  const r = csv.parseCatalogue(text);
  assert.ok(r.ok, `expected a parse, got: ${JSON.stringify(r.problems)}`);
  return r;
};

await check("unrecognised headings are blocked by default and read once the customer maps them", () => {
  const text = "Product Name,Ctry,Price\nshirt,China,10\nmug,DE,5\n";
  const blocked = csv.parseCatalogue(text);
  assert.equal(blocked.ok, false, "no alias matches, so required columns are missing");
  assert.deepEqual(csv.readHeaders(text), ["Product Name", "Ctry", "Price"]);
  const mapped = csv.parseCatalogue(text, { description: 0, country: 1, value: 2 });
  assert.ok(mapped.ok, JSON.stringify(mapped));
  assert.deepEqual(mapped.items.map((i) => [i.description, i.country, i.value]), [["shirt", "China", 10], ["mug", "DE", 5]]);
});

await check("an explicit mapping overrides an alias that would otherwise match a different column", () => {
  const text = "description,country,value,hts\nshirt,China,10,6109.10.00.12\n";
  const r = csv.parseCatalogue(text, { description: 0, country: 1, value: 2, hts: 0 });
  assert.ok(r.ok);
  assert.equal(r.items[0].hts, "shirt", "the mapping's choice wins, not the header name");
});

await check("a product row can be changed in place, and nothing else moves", () => {
  const text = "sku,description,country,value,hts\nA,\"cotton shirt, knitted\",China,100,\nB,mug,Germany,50,\n";
  const next = csv.updateRow(text, 1, { hts: "6109.10.00.12", value: "200" });
  assert.ok(next, "row 1 exists");
  const r = csv.parseCatalogue(next);
  assert.ok(r.ok);
  assert.equal(r.items[0].hts, "6109.10.00.12");
  assert.equal(r.items[0].value, 200);
  assert.equal(r.items[0].description, "cotton shirt, knitted", "a comma inside a quoted cell survives the rewrite");
  assert.equal(r.items[1].hts, null, "the other row is untouched");
  assert.equal(r.items[1].value, 50);
});

await check("a row edit refuses a row that does not exist or a field the file does not have", () => {
  const text = "description,country,value\nshirt,China,10\n";
  assert.equal(csv.updateRow(text, 5, { country: "Vietnam" }), null, "no such row");
  assert.equal(csv.updateRow(text, 1, { hts: "6109.10.00.12" }), null, "the file has no hts column");
});

await check("every data row is kept, numbered from 1, blank lines skipped, header excluded", () => {
  const r = ok("sku,description,country,value\n\nA,shirt,China,10\n\n   \nB,,China,x\nC,mug,DE,5\n");
  assert.deepEqual(r.items.map((i) => i.row), [1, 2, 3]);
  assert.deepEqual(r.items.map((i) => i.sku), ["A", "B", "C"]);
});

await check("a row that cannot be read is kept with amount 0 and flagged, not dropped", () => {
  const r = ok("description,country,value\nshirt,China,abc\n,China,10\nmug,,5\nbag,China,-3\ncap,China,");
  assert.equal(r.items.length, 5);
  assert.deepEqual(r.items.map((i) => i.value), [0, 10, 5, 0, 0]);
  assert.equal(r.incomplete, 5);
  assert.match(r.items[0].problems.join(), /amount not readable/);
  assert.match(r.items[1].problems.join(), /no description/);
  assert.match(r.items[2].problems.join(), /no country/);
});

await check("currency-formatted amounts are read", () => {
  const amounts = ["$1,000.50", "1,000", "  2 500 ", "$ 12", "USD 1,234,567.89", "1000", ".5", "12.00"];
  const want = [1000.5, 1000, 2500, 12, 1234567.89, 1000, 0.5, 12];
  amounts.forEach((a, i) => assert.equal(csv.parseAmount(a), want[i], a));
});

await check("ambiguous or malformed amounts are not guessed at", () => {
  for (const a of ["1.000,50", "1,5", "12,34,56", "abc", "", "1e5", "10-20", "--3", "(500)"]) {
    assert.equal(csv.parseAmount(a), null, a);
  }
});

await check("a UTF-8 BOM does not corrupt the first header", () => {
  const r = ok("﻿description,country,value\nshirt,China,10");
  assert.equal(r.items[0].description, "shirt");
});

await check("quoted fields keep embedded commas, newlines and escaped quotes", () => {
  const r = ok('description,country,value,sku\r\n"shirt, cotton ""slim""\nfit",China,"1,000.50","A,1"\r\nmug,DE,5,B\r\n');
  assert.equal(r.items.length, 2);
  assert.equal(r.items[0].description, 'shirt, cotton "slim"\nfit');
  assert.equal(r.items[0].value, 1000.5);
  assert.equal(r.items[0].sku, "A,1");
  assert.equal(r.items[1].description, "mug");
});

await check("a bare quote inside an unquoted field is literal", () => {
  const r = ok('description,country,value\nsteel pipe 5" wide,China,10');
  assert.equal(r.items[0].description, 'steel pipe 5" wide');
});

await check("lone CR, CRLF and LF line endings all work", () => {
  for (const nl of ["\n", "\r\n", "\r"]) {
    const r = ok(["description,country,value", "a,China,1", "b,China,2"].join(nl));
    assert.equal(r.items.length, 2, JSON.stringify(nl));
  }
});

await check("a paste from a spreadsheet (tab-separated) is read", () => {
  const r = ok("sku\tdescription\tcountry\tvalue\nA\tshirt, cotton\tChina\t$1,000");
  assert.equal(r.items[0].description, "shirt, cotton");
  assert.equal(r.items[0].value, 1000);
});

await check("header aliases are accepted", () => {
  const r = ok("Product,Country of Origin,Entered Value (USD),Part Number,HTS Code\nshirt,China,10,P1,6109.10.00.12");
  assert.equal(r.items[0].description, "shirt");
  assert.equal(r.items[0].country, "China");
  assert.equal(r.items[0].value, 10);
  assert.equal(r.items[0].sku, "P1");
  assert.equal(r.items[0].hts, "6109.10.00.12");
});

await check("a missing required column is named", () => {
  const r = csv.parseCatalogue("sku,description,origin\nA,shirt,China");
  assert.equal(r.ok, false);
  assert.match(r.problems.join("\n"), /“value” column/);
  const r2 = csv.parseCatalogue("sku,value\nA,1");
  assert.match(r2.problems.join("\n"), /“description”/);
  assert.match(r2.problems.join("\n"), /“country”/);
});

await check("a duplicate column is named and blocks", () => {
  const r = csv.parseCatalogue("description,country,value,amount\nshirt,China,1,2");
  assert.equal(r.ok, false);
  assert.match(r.problems.join("\n"), /“value” column appears more than once/);
});

await check("a header with no rows under it, and empty input, are explained", () => {
  assert.equal(csv.parseCatalogue("description,country,value\n").ok, false);
  assert.equal(csv.parseCatalogue("   \n\n").ok, false);
});

await check("fields longer than the engine's limits are shortened and flagged, not sent to reject the batch", () => {
  const r = ok(`sku,description,country,value\n${"S".repeat(100)},shirt,China,1`);
  assert.equal(r.items[0].sku.length, 64);
  assert.match(r.items[0].problems.join(), /sku shortened/);
});

await check("the template and sample are themselves valid", () => {
  assert.ok(csv.parseCatalogue(csv.TEMPLATE_CSV).ok);
  assert.equal(ok(csv.SAMPLE_CSV).items.length, 5);
});

await check("quantity, unit and program columns are read; a bad quantity is flagged, never silently zero", () => {
  const r = ok("sku,description,country,value,qty,uom,program\n" +
    "A,cheese,Canada,100,2500,kg,s\n" +
    "B,cheese,Canada,100,1,200,\n" +
    "C,cheese,Canada,100,,,\n" +
    "D,cheese,Canada,100,-4,lb,\n");
  const [a, b, c, d] = r.items;
  assert.deepEqual([a.quantity, a.quantityUnit, a.program], [2500, "kg", "S"]);
  assert.deepEqual([c.quantity, c.quantityUnit, c.program], [null, "", ""]);
  assert.equal(d.quantity, null);
  assert.match(d.problems.join(), /quantity not readable/);
  assert.equal(r.items.length, 4, "no row is dropped");
  assert.equal(b.quantity, 1);
});

await check("the template carries the optional columns and reads back with a quantity", () => {
  const r = ok(csv.TEMPLATE_CSV);
  assert.deepEqual(r.items.map((i) => i.quantity), [null, null, 2500, null]);
  assert.equal(r.items[2].program, "S");
  assert.deepEqual(r.ignored, []);
});

await check("metal weight, vehicle use and end use are read; a metal weight over 100 or unreadable is flagged", () => {
  const r = ok("sku,description,country,value,metal weight (%),vehicle use,end use\n" +
    "A,hinge,China,100,60%,none,\n" +
    "B,hinge,China,100,140,passenger,\n" +
    "C,valve,China,100,,,pharmaceutical\n" +
    "D,hinge,China,100,abc,heavy,\n");
  const [a, b, c, d] = r.items;
  assert.deepEqual([a.metalWeightPct, a.vehicleUse, a.endUse], [60, "none", ""]);
  assert.equal(b.metalWeightPct, null);
  assert.match(b.problems.join(), /metal weight not readable/);
  assert.match(d.problems.join(), /metal weight not readable/);
  assert.deepEqual([c.metalWeightPct, c.vehicleUse, c.endUse], [null, "", "pharmaceutical"]);
  assert.equal(r.items.length, 4, "no row is dropped");
});

// --- the shared model and export -------------------------------------------

await check("counts are a partition: ready + review + failed = submitted", () => {
  const lines = ["ready", "ready", "scope_review", "incomplete", "suffix_review", "low_confidence",
    "error", "unclassified", "not_processed"].map((status) => ({ status }));
  const c = model.countLines(lines);
  assert.equal(c.submitted, 9);
  assert.equal(c.ready + c.review + c.failed, c.submitted);
  assert.deepEqual([c.ready, c.review, c.failed, c.unresolved], [2, 4, 3, 7]);
});

await check("the export carries Row, Status and Review notes, and neutralises formulas", () => {
  const cols = out.AUDIT_COLUMNS.map((c) => c.label);
  for (const c of ["Row", "Status", "Review notes"]) assert.ok(cols.includes(c), c);
  const row = out.auditExportRow({
    row: 7, sku: "=1+1", description: "@evil", country: "China", hts: null, status: "error",
    error: "Bad value", review_reasons: ["Bad value"], warnings: ["-w"],
  });
  assert.equal(row.status, "Error");
  assert.equal(row.review_notes, "Bad value | -w", "the engine repeats a message; it is shown once");
  const text = out.toCsv([row], out.AUDIT_COLUMNS);
  assert.match(text, /"'=1\+1"/);
  assert.match(text, /"'@evil"/);
  assert.match(text, /"7"/);
  const legacy = out.auditExportRow({ description: "x", country: "DE", status: null });
  assert.equal(legacy.status, "Saved before review states existed");
});

await check("projection keeps only signed fields and rejects a non-line", () => {
  const l = model.projectLine({ row: 1, sku: "A", description: "d", country: "C", hts: null, status: "ready",
    duty: 1, suggested: [{ hts: "x" }], evil: "x", warnings: ["w"] });
  // "evil" is not a field projectLine knows about, so it must never appear —
  // that is the actual point of a signed projection. "evidence" is a real,
  // signed field (the classifier's top candidate, via projectEvidence),
  // derived here from `suggested[0]`.
  assert.deepEqual(Object.keys(l).sort(), ["country", "description", "duty", "evidence", "hts", "row", "sku", "status", "warnings"]);
  assert.ok(!("evil" in l), "an unrecognised field leaked into the signed projection");
  assert.equal(l.evidence.candidate_hts, "x");
  assert.equal(model.projectLine({ row: 1, status: "bogus" }), null);
  assert.equal(model.projectLine({ status: "ready" }), null);
  assert.equal(model.projectLine(null), null);
  assert.equal(model.projectLine({ row: 1, status: "ready", duty: "9" }).duty, undefined);
});

process.exit(finish());
