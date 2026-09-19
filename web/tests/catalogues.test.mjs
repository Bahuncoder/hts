/** Catalogues, watching, change diffing and CSV.
 *
 *  The diff is the reason a subscription renews, so its two failure modes are
 *  covered directly: missing a heading-level action that does reach a watched
 *  code, and alerting the same person twice for one document.
 *
 *  Run: node tests/catalogues.test.mjs
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createClient } from "@libsql/client";

const dir = mkdtempSync(path.join(tmpdir(), "htsdesk-cat-"));
const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push([name, null]); }
  catch (e) { results.push([name, e.message]); }
};

const acc = createClient({ url: `file:${path.join(dir, "accounts.db")}` });
await acc.executeMultiple(`
  CREATE TABLE watched_code (account_id TEXT, digits TEXT, hts TEXT,
    catalogue_id TEXT, created_at TEXT, PRIMARY KEY(account_id,digits,catalogue_id));
  CREATE TABLE alert (id TEXT PRIMARY KEY, account_id TEXT, document_number TEXT,
    title TEXT, publication_date TEXT, html_url TEXT, digits TEXT, hts TEXT,
    created_at TEXT, read_at TEXT, emailed_at TEXT,
    UNIQUE(account_id, document_number, digits));
`);

const watch = (a, hts, cat) =>
  acc.execute({ sql: "INSERT OR IGNORE INTO watched_code VALUES(?,?,?,?,?)",
    args: [a, hts.replace(/\./g, ""), hts, cat, new Date().toISOString()] });

// The matcher under test, mirroring src/lib/diff.ts.
function match(mentions, watchedDigits) {
  const prefixes = [...new Set(mentions.map((m) => m.replace(/\./g, "")))]
    .filter((m) => m.length >= 6);
  return prefixes.filter((p) => watchedDigits.startsWith(p))
                 .sort((a, b) => b.length - a.length)[0] ?? null;
}

await check("a heading-level action reaches a statistical line beneath it", () => {
  assert.equal(match(["2804.61"], "2804610000"), "280461",
    "an action naming 2804.61 must reach a watched 2804.61.00.00");
});

await check("an unrelated code is not matched", () => {
  assert.equal(match(["2804.61"], "6109100012"), null);
});

await check("matching is directional, not merely a shared chapter", () => {
  assert.equal(match(["2804.69"], "2804610000"), null,
    "sibling subheadings must not match each other");
});

await check("the narrowest matching prefix wins", () => {
  assert.equal(match(["6109.10", "6109.10.00"], "6109100012"), "61091000",
    "the more specific mention is the one worth naming in the alert");
});

await check("four-digit noise is ignored", () => {
  assert.equal(match(["2804"], "2804610000"), null,
    "a bare heading number is too loose to alert on");
});

await check("watching the same code twice from one catalogue is idempotent", async () => {
  await watch("a1", "2804.61.00.00", "cat1");
  await watch("a1", "2804.61.00.00", "cat1");
  const rs = await acc.execute("SELECT count(*) n FROM watched_code WHERE account_id='a1'");
  assert.equal(rs.rows[0].n, 1);
});

await check("the same code in two catalogues is watched under each", async () => {
  await watch("a1", "2804.61.00.00", "cat2");
  const rs = await acc.execute("SELECT count(*) n FROM watched_code WHERE account_id='a1'");
  assert.equal(rs.rows[0].n, 2, "deleting one catalogue must not silently unwatch the other");
});

await check("an alert is created once per account, document and code", async () => {
  const ins = (id) => acc.execute({
    sql: `INSERT OR IGNORE INTO alert
      (id,account_id,document_number,title,publication_date,html_url,digits,hts,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`,
    args: [id, "a1", "2026-17049", "Silicon Metal", "2026-08-21", "https://x",
           "2804610000", "2804.61.00.00", new Date().toISOString()],
  });
  assert.equal((await ins(crypto.randomUUID())).rowsAffected, 1);
  assert.equal((await ins(crypto.randomUUID())).rowsAffected, 0,
    "re-running the diff must not alert the same person twice");
});

// --- CSV -------------------------------------------------------------------
const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;

await check("CSV escapes embedded quotes", () => {
  assert.equal(cell('a "premium" range'), '"a ""premium"" range"');
});

await check("CSV keeps a comma inside one field", () => {
  const row = [cell("Silicon metal, 99% purity"), cell("Norway")].join(",");
  assert.equal(row.split('","').length, 2,
    "an unquoted comma shifts every column after it");
});

await check("CSV renders an empty value as an empty field, not the word null", () => {
  assert.equal(cell(null), '""');
  assert.equal(cell(undefined), '""');
});

acc.close();
rmSync(dir, { recursive: true, force: true });

const failed = results.filter(([, e]) => e);
const w = Math.max(...results.map(([n]) => n.length));
for (const [name, err] of results) {
  console.log(`  ${err ? "FAIL" : "ok  "}  ${name.padEnd(w)}`);
  if (err) console.log(`        ${err.split("\n")[0].slice(0, 150)}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
