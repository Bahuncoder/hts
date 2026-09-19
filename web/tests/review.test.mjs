/** The catalogue audit as a review workspace, and honest saved catalogues,
 *  driven in a real browser against the production build.
 *
 *  Production build on 3311 (3312 for the unsigned case), a fake engine on
 *  3341 that follows the real /api/audit contract (tests/auditfixture.mjs) so
 *  every status can be produced on demand, and a scratch accounts database with
 *  a seeded signed-in account.
 *
 *  Run: node tests/review.test.mjs
 *  Set HTSDESK_SHOTS=<dir> to keep screenshots of the results.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { fakeServer, json, readBody, seedAccount, startApp, suite } from "./harness.mjs";
import { auditResponse } from "./auditfixture.mjs";

const SHOTS = process.env.HTSDESK_SHOTS;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const engine = { calls: [], mode: "ok" };
const fake = await fakeServer(3341, async (req, res) => {
  const body = JSON.parse(await readBody(req));
  engine.calls.push(body);
  if (engine.mode === "down") return json(res, 500, { detail: "engine down" });
  if (body.items.some((i) => String(i.description).includes("slow"))) await new Promise((r) => setTimeout(r, 1200));
  return json(res, 200, auditResponse(body));
});

const env = { HTSDESK_API: "http://127.0.0.1:3341", HTSDESK_API_KEY: "k" };
const app = await startApp({ port: 3311, env });
const db = app.db();

async function session(id) {
  await seedAccount(db, { id, plan: "growth" });
  const token = crypto.randomBytes(16).toString("hex");
  await db.execute({ sql: "INSERT INTO session(token, account_id, expires_at) VALUES(?,?,?)",
    args: [token, id, new Date(Date.now() + 3_600_000).toISOString()] });
  return token;
}
const token = await session("reviewer");

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
async function newPage(base = app.base, tok = token, viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  if (tok) await ctx.addCookies([{ name: "htsdesk_session", value: tok, url: base }]);
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) page.errors.push(m.text()); });
  return { ctx, page };
}

const MIXED = [
  "sku,description,country,value,hts",
  'A-1,ready shirt,China,"$1,000.50",',
  "A-2,scope shirt,China,2000,",
  "A-3,suffix mug,Germany,300,",
  "A-4,lowconf bag,China,400,",
  "",
  "A-5,incomplete thing,China,500,",
  "A-6,noclass,China,600,",
  "A-7,bad amount,China,abc,",
  "A-8,typo country,Chnia,700,9999.99.99.99",
  'A-9,"quoted, with comma",China,800,',
].join("\n");

const { check, finish } = suite();
const { ctx, page } = await newPage();
const body = () => page.locator("body").innerText();
const rowsOf = () => page.locator("tbody tr").filter({ has: page.getByRole("button", { name: /Details|Hide details/ }) });

/** Runs an audit and returns once ITS results are on screen. Earlier results
 *  stay visible while a new run is in flight, so waiting for the results
 *  element alone would return at once with the old ones. */
async function finishRun(p, before) {
  for (let i = 0; i < 200 && engine.calls.length <= before; i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(engine.calls.length > before, "the audit request was never sent");
  await p.getByRole("button", { name: "Run audit" }).waitFor({ timeout: 20000 });
  await p.locator('[data-testid="reconciliation"]').waitFor({ timeout: 20000 });
}
async function runOn(p, text) {
  const before = engine.calls.length;
  await p.fill("textarea", text);
  await p.getByRole("button", { name: "Run audit" }).click();
  await finishRun(p, before);
}
const runAudit = (text) => runOn(page, text);

try {
  await page.goto(`${app.base}/audit`, { waitUntil: "networkidle" });

  await check("the page opens empty: a sample is an explicit action, not prefilled data", async () => {
    assert.equal(await page.inputValue("textarea"), "");
    await page.getByRole("button", { name: "Try a sample" }).click();
    assert.match(await page.inputValue("textarea"), /TS-001/);
    assert.match(await body(), /This is sample data, not yours/);
    const n = engine.calls.length;
    await page.getByRole("button", { name: "Run audit" }).click();
    await finishRun(page, n);
    assert.match(await body(), /results for the sample catalogue, not your data/);
    assert.equal(await page.getByRole("button", { name: /Save and watch/ }).isDisabled(), true,
      "sample results must not be saved as the customer's catalogue");
    await page.getByRole("button", { name: "Clear" }).click();
    assert.equal(await page.inputValue("textarea"), "");
  });

  await check("a header problem is named and blocks the run; the template is offered", async () => {
    const before = engine.calls.length;
    await page.fill("textarea", "sku,description,value\nA,shirt,10");
    assert.match(await page.locator("#catalogue-preflight").innerText(), /Missing the “country” column/);
    await page.getByRole("button", { name: "Run audit" }).click();
    assert.equal(await page.locator('#catalogue-preflight[role="alert"]').count(), 1, "announced as an alert");
    assert.equal(engine.calls.length, before, "nothing was sent");
    const href = await page.getByRole("link", { name: "Download template" }).last().getAttribute("href");
    assert.match(href, /^data:text\/csv/);
    assert.match(decodeURIComponent(href), /sku,description,country,value,hts/);
    await page.fill("textarea", "description,country,value,amount\nshirt,China,1,2");
    assert.match(await page.locator("#catalogue-preflight").innerText(), /“value” column appears more than once/);
  });

  await check("every row is sent with its row number; unreadable amounts go as 0", async () => {
    engine.calls.length = 0;
    await page.fill("textarea", MIXED);
    assert.match(await page.locator("#catalogue-preflight").innerText(), /9 rows read · 1 look incomplete/);
    await page.getByRole("button", { name: "Run audit" }).click();
    await finishRun(page, 0);
    const sent = engine.calls.at(-1);
    assert.equal(sent.items.length, 9, "no row filtered out");
    assert.deepEqual(sent.items.map((i) => i.row), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.deepEqual(sent.items.map((i) => i.value), [1000.5, 2000, 300, 400, 500, 600, 0, 700, 800]);
    assert.equal(sent.items[8].description, "quoted, with comma");
    assert.equal(sent.entries, 1);
    assert.equal(sent.by_vessel, true);
  });

  await check("the reconciliation line adds up and partial totals are marked beside the amounts", async () => {
    const line = (await page.locator('[data-testid="reconciliation"]').innerText()).replace(/\s+/g, " ");
    assert.match(line, /Submitted 9 · Ready 2 · Needs attention 7/);
    const marks = await page.getByText("Partial: 7 lines unresolved").count();
    assert.ok(marks >= 3, `expected the marker on entered value, duty and refundable; found ${marks}`);
    // Beside the amount: same block as the figure, not a footnote.
    const card = page.locator("div.rounded-lg", { hasText: "Entered value" }).first();
    assert.match(await card.innerText(), /\$\d[\d,.]*[\s\S]*Partial: 7 lines unresolved/);
    assert.match(await body(), /Reference data revision:\s*test-rev-1/i);
  });

  await check("filters partition the lines and show counts; statuses are words", async () => {
    const counts = async () => Object.fromEntries(await Promise.all(
      ["All", "Needs review", "Ready", "Failed"].map(async (n) =>
        [n, (await page.getByRole("button", { name: new RegExp(`^${n} \\(`) }).innerText()).match(/\((\d+)\)/)[1]])));
    assert.deepEqual(await counts(), { All: "9", "Needs review": "4", Ready: "2", Failed: "3" });
    assert.equal(await rowsOf().count(), 9);
    await page.getByRole("button", { name: /^Failed \(/ }).click();
    assert.equal(await rowsOf().count(), 3);
    const failed = (await page.locator("tbody").innerText()).toLowerCase();
    assert.ok(failed.includes("not classified") && failed.includes("error"));
    await page.getByRole("button", { name: /^Needs review \(/ }).click();
    const review = (await page.locator("tbody").innerText()).toLowerCase();
    for (const t of ["scope review", "confirm code", "low confidence", "incomplete"]) assert.ok(review.includes(t), t);
    await page.getByRole("button", { name: /^Ready \(/ }).click();
    assert.equal(await rowsOf().count(), 2);
    assert.equal(await page.getByRole("button", { name: /^Ready \(/ }).getAttribute("aria-pressed"), "true");
    await page.getByRole("button", { name: /^All \(/ }).click();
  });

  await check("SKU and description sit together, with row numbers", async () => {
    const first = rowsOf().first();
    const t = await first.innerText();
    assert.match(t, /A-1/);
    assert.match(t, /ready shirt/);
    assert.match(t, /\b1\b/);
  });

  await check("a row expands to reasons, warnings, candidates and alternatives", async () => {
    const scope = rowsOf().filter({ hasText: "scope shirt" });
    await scope.getByRole("button", { name: /Details/ }).click();
    const detail = await page.locator("tr.bg-sunk").innerText();
    assert.match(detail, /Why this needs review/i);
    assert.match(detail, /need scope verification/);
    assert.match(detail, /Warnings/i);
    assert.match(detail, /Classifier candidates/i);
    assert.match(detail, /6109\.10\.00\.07/);
    assert.match(detail, /Used for this price/i);
    assert.match(detail, /9903\.05\.31/);
    await scope.getByRole("button", { name: /Hide details/ }).click();

    const suffix = rowsOf().filter({ hasText: "suffix mug" });
    await suffix.getByRole("button", { name: /Details/ }).click();
    assert.match(await page.locator("tr.bg-sunk").innerText(), /Sibling statistical lines with different rates[\s\S]*6109\.10\.00\.04/i);
    await suffix.getByRole("button", { name: /Hide details/ }).click();

    const bad = rowsOf().filter({ hasText: "bad amount" });
    await bad.getByRole("button", { name: /Details/ }).click();
    assert.match(await page.locator("tr.bg-sunk").innerText(), /What went wrong[\s\S]*Entered value must be a positive amount/i);
    assert.match(await page.locator("tr.bg-sunk").innerText(), /no figures and is not in the totals/);
    await bad.getByRole("button", { name: /Hide details/ }).click();
  });

  await check("assumptions are listed, and entries and transport reach the engine", async () => {
    await page.locator("details", { hasText: "Assumptions behind these figures" }).locator("summary").click();
    assert.match(await body(), /Vessel shipment assumed/);
    await page.locator("details", { hasText: /^Assumptions: 1 formal entry/ }).locator("summary").click();
    await page.fill('input[type="number"]', "3");
    await page.selectOption("select", "air");
    const n = engine.calls.length;
    await page.getByRole("button", { name: "Run audit" }).click();
    await finishRun(page, n);
    await page.getByText(/spread over 3 formal entries/).first().waitFor({ timeout: 15000 });
    const sent = engine.calls.at(-1);
    assert.equal(sent.entries, 3);
    assert.equal(sent.by_vessel, false);
    assert.match(await body(), /Non-vessel shipment/);
  });

  await check("progress is announced while running and the button cannot be double-pressed", async () => {
    await page.fill("textarea", "sku,description,country,value\nS-1,slow shirt,China,100");
    await page.getByRole("button", { name: "Run audit" }).click();
    await page.getByRole("status").filter({ hasText: /Auditing 1 rows/ }).waitFor({ timeout: 5000 });
    assert.equal(await page.getByRole("button", { name: /Auditing/ }).isDisabled(), true);
    await page.getByRole("button", { name: "Run audit" }).waitFor({ timeout: 15000 });
    assert.match(await body(), /Submitted 1 · Ready 1/);
  });

  await check("a changed catalogue is flagged against results from the earlier text", async () => {
    await page.fill("textarea", "sku,description,country,value\nS-2,another shirt,China,5");
    assert.match(await body(), /You have changed the catalogue since this audit/);
  });

  await check("a failed re-run keeps the previous result and never leaves the button busy", async () => {
    await runAudit(MIXED);
    engine.mode = "down";
    await page.getByRole("button", { name: "Run audit" }).click();
    await page.locator('[role="alert"]').filter({ hasText: /engine down/ }).waitFor({ timeout: 10000 });
    assert.match(await page.locator('[role="alert"]').filter({ hasText: /engine down/ }).innerText(), /previous successful audit/);
    assert.match((await page.locator('[data-testid="reconciliation"]').innerText()).replace(/\s+/g, " "), /Submitted 9/);
    assert.equal(await page.getByRole("button", { name: "Run audit" }).isEnabled(), true);
    engine.mode = "ok";

    // A dropped connection, too.
    await page.route("**/api/audit", (r) => r.abort("connectionreset"));
    await page.getByRole("button", { name: "Run audit" }).click();
    await page.locator('[role="alert"]').filter({ hasText: /Could not reach the audit service/ }).waitFor({ timeout: 10000 });
    assert.equal(await page.getByRole("button", { name: "Run audit" }).isEnabled(), true);
    assert.equal(await rowsOf().count(), 9, "the earlier results are still there");
    await page.unroute("**/api/audit");
  });

  await check("a 1,000-line catalogue is paged, 100 at a time", async () => {
    const rows = ["sku,description,country,value"];
    for (let i = 1; i <= 250; i++) rows.push(`P-${i},${i % 7 === 0 ? "scope " : ""}item ${i},China,${i}`);
    await runAudit(rows.join("\n"));
    assert.equal(await rowsOf().count(), 100);
    assert.match(await body(), /Lines 1–100 of 250/);
    await page.getByRole("button", { name: "Next" }).click();
    assert.match(await body(), /Lines 101–200 of 250/);
    await page.getByRole("button", { name: "Next" }).click();
    assert.equal(await rowsOf().count(), 50);
    await page.getByRole("button", { name: /^Needs review \(/ }).click();
    assert.match(await body(), /Lines 1–35 of 35|35 shown|of 35/, "the page resets when the filter changes");
  });

  await check("upload is keyboard-operable with a visible focus ring", async () => {
    await page.fill("textarea", "");
    await page.locator("textarea").focus();
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "catalogue-file");
    const outline = await page.evaluate(() => getComputedStyle(document.querySelector('label[for="catalogue-file"]')).outlineStyle);
    assert.notEqual(outline, "none", "the label shows a focus ring when the input has keyboard focus");
    const f = path.join(app.dbPath, "..", "upload.csv");
    fs.writeFileSync(f, "﻿description,country,value\r\nuploaded shirt,China,42\r\n");
    await page.setInputFiles("#catalogue-file", f);
    await page.getByText("Loaded upload.csv.").waitFor();
    assert.match(await page.inputValue("textarea"), /uploaded shirt/);
    assert.match(await page.locator("#catalogue-preflight").innerText(), /1 rows read/);
  });

  await check("the textarea is labelled", async () => {
    assert.equal(await page.getByLabel("Your catalogue").count(), 1);
  });

  await check("the audit CSV has Row, Status and Review notes, keeps every line, and is formula-safe", async () => {
    await runAudit([
      "sku,description,country,value",
      "=1+1,ready shirt,China,10",
      "S-2,noclass,China,20",
      "S-3,scope shirt,China,30",
    ].join("\n"));
    const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export CSV" }).click()]);
    let csv = ""; for await (const c of await dl.createReadStream()) csv += c;
    assert.ok(csv.startsWith("﻿"));
    assert.match(csv, /^﻿"Row","SKU","Description","Country of origin","HTS code","Status","Review notes"/);
    const lines = csv.trim().split("\r\n");
    assert.equal(lines.length, 4, "header + all three lines, including the unclassified one");
    assert.match(lines[1], /"'=1\+1"/, "formula neutralised");
    assert.match(lines[2], /"Not classified","Could not classify this product from its description\."/);
    assert.match(lines[3], /"Scope review"/);
  });

  await check("no page errors so far", () => assert.deepEqual(page.errors, []));

  // ---- saving -------------------------------------------------------------

  let catalogueId;
  await check("saving stores EVERY line and watches only priced codes", async () => {
    await runAudit(MIXED);
    await page.fill('input[placeholder*="Autumn"]', "Review range");
    await Promise.all([
      page.waitForURL(/\/catalogues\/[0-9a-f-]{36}/, { timeout: 30000 }),
      page.getByRole("button", { name: "Save and watch these codes" }).click(),
    ]);
    catalogueId = page.url().split("/").pop();

    const items = (await db.execute({ sql: "SELECT * FROM catalogue_item WHERE catalogue_id=? ORDER BY row_number", args: [catalogueId] })).rows;
    assert.equal(items.length, 9, "nothing dropped, failures included");
    assert.deepEqual(items.map((i) => i.row_number), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.deepEqual(items.map((i) => i.status),
      ["ready", "scope_review", "suffix_review", "low_confidence", "incomplete", "unclassified", "error", "error", "ready"]);
    assert.equal(items[6].value, 0, "an unreadable amount is stored as the 0 that was submitted");
    assert.equal(items[5].value, 600, "an unclassified line keeps the amount that was entered");
    assert.match(items[6].error, /positive amount/);
    assert.match(JSON.parse(items[1].review_json)[0], /scope verification/);
    assert.ok(JSON.parse(items[1].warnings_json).length >= 1);
    assert.match(JSON.parse(items[4].incomplete_json)[0], /quantity-based/);
    assert.equal(items[7].hts, "9999.99.99.99", "the code as submitted is kept");

    const watched = (await db.execute({ sql: "SELECT DISTINCT digits FROM watched_code WHERE catalogue_id=?", args: [catalogueId] })).rows.map((r) => r.digits);
    assert.deepEqual(watched, ["6109100012"], "the error line's bogus code and unclassified lines are not watched");

    const cat = (await db.execute({ sql: "SELECT * FROM catalogue WHERE id=?", args: [catalogueId] })).rows[0];
    assert.equal(cat.dataset_revision, "test-rev-1");
    assert.equal(cat.totals_complete, 0);
    assert.ok(Math.abs(Date.now() - Date.parse(cat.calculated_at)) < 60_000);
    assert.match(cat.assumptions_json, /Non-vessel shipment/, 'the assumptions the customer chose (3 entries, air) are what is saved');
    assert.match(cat.assumptions_json, /3 formal entries/);
    assert.equal(cat.mpf, 100.74, "the entry-level fee, for 3 entries");
  });

  await check("the saved catalogue reconciles, marks partial totals, and lists unresolved lines first", async () => {
    // The URL changes before the new page has streamed in.
    await page.locator('[data-testid="reconciliation"]').waitFor({ timeout: 15000 });
    const t = await body();
    assert.match((await page.locator('[data-testid="reconciliation"]').innerText()).replace(/\s+/g, " "), /Submitted 9 · Ready 2 · Needs attention 7/);
    assert.match(t, /Partial: 7 lines unresolved/);
    assert.match(t, /reference data revision\s+test-rev-1/i);
    assert.match(t, /Calculated .*UTC/);
    await page.locator("details", { hasText: "Assumptions behind these figures" }).locator("summary").click();
    assert.match(await body(), /Non-vessel shipment/);
    assert.match(t, /1 code watched/);
    const statusCol = await page.locator("tbody tr td:last-child").allInnerTexts();
    const firstReady = statusCol.findIndex((s) => /^ready/i.test(s.trim()));
    const lastUnresolved = statusCol.map((s) => !/^ready/i.test(s.trim())).lastIndexOf(true);
    assert.ok(lastUnresolved < firstReady, "no ready line sits above an unresolved one");
    assert.match(await page.locator("tbody").innerText(), /Not classified/i);
    // Reasons available without scripts.
    await page.locator("tbody details summary").first().click();
    assert.ok((await page.locator("tbody details[open] ul li").count()) >= 1);
  });

  await check("the saved catalogue filters to failed lines", async () => {
    await page.getByRole("link", { name: /^Failed \(/ }).click();
    await page.waitForURL(/show=failed/);
    assert.equal(await page.locator("tbody tr").count(), 3);
    assert.match(await page.locator("tbody").innerText(), /bad amount/);
  });

  await check("the saved export includes every line, status and reasons", async () => {
    await page.goto(`${app.base}/catalogues/${catalogueId}`, { waitUntil: "networkidle" });
    const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Export CSV" }).click()]);
    let csv = ""; for await (const c of await dl.createReadStream()) csv += c;
    const lines = csv.trim().split("\r\n");
    assert.equal(lines.length, 10);
    assert.match(lines[0], /"Row","SKU","Description","Country of origin","HTS code","Status","Review notes"/);
    assert.ok(lines.some((l) => /"Error","Entered value must be a positive amount\."/.test(l)));
    assert.ok(lines.some((l) => /"Not classified"/.test(l)));
  });

  // ---- tampering ----------------------------------------------------------

  await check("a save with edited figures, or without its proof, is refused", async () => {
    const attempt = async (edit) => {
      await page.goto(`${app.base}/audit`, { waitUntil: "networkidle" });
      await runAudit(MIXED);
      await page.fill('input[placeholder*="Autumn"]', "Tampered");
      let seen = null;
      await page.route("**/audit", async (route) => {
        const req = route.request();
        if (req.method() === "POST" && req.headers()["next-action"]) {
          seen = req.postData();
          return route.continue({ postData: edit(seen) });
        }
        return route.continue();
      });
      await page.getByRole("button", { name: "Save and watch these codes" }).click();
      await page.locator('p[role="alert"]').waitFor({ timeout: 15000 });
      const message = await page.locator('p[role="alert"]').innerText();
      await page.unroute("**/audit");
      assert.ok(seen, "the save request was intercepted");
      return message;
    };
    const before = (await db.execute("SELECT count(*) AS n FROM catalogue")).rows[0].n;

    const m1 = await attempt((b) => { assert.match(b, /"duty":/); return b.replace(/"status":"scope_review"/, '"status":"ready"'); });
    assert.match(m1, /Run the audit again to save it/);
    const m2 = await attempt((b) => b.replace(/"duty":\d+(\.\d+)?/, '"duty":0'));
    assert.match(m2, /Run the audit again to save it/);
    const m3 = await attempt((b) => b.replace(/"[A-Za-z0-9_-]{43}"/, '"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"'));
    assert.match(m3, /Run the audit again to save it/);
    const m4 = await attempt((b) => b.replace(/"mpf":[\d.]+/, '"mpf":0'));
    assert.match(m4, /Run the audit again to save it/);

    const after = (await db.execute("SELECT count(*) AS n FROM catalogue")).rows[0].n;
    assert.equal(after, before, "nothing was saved");
  });

  await check("a save that exceeds the plan ceiling counts submitted lines, failures included", async () => {
    const tok = await session("freebie");
    await db.execute({ sql: "UPDATE subscription SET plan='free' WHERE account_id='freebie'" });
    const { ctx: c2, page: p2 } = await newPage(app.base, tok);
    try {
      await p2.goto(`${app.base}/audit`, { waitUntil: "networkidle" });
      const rows = ["sku,description,country,value"];
      for (let i = 1; i <= 25; i++) rows.push(`F-${i},${i <= 20 ? "noclass" : "shirt"},China,${i}`);
      await runOn(p2, rows.join("\n"));
      await p2.fill('input[placeholder*="Autumn"]', "Free five");
      await Promise.all([
        p2.waitForURL(/\/catalogues\/[0-9a-f-]{36}/, { timeout: 15000 }),
        p2.getByRole("button", { name: "Save and watch these codes" }).click(),
      ]);
      const id = p2.url().split("/").pop();
      const n = (await db.execute({ sql: "SELECT count(*) AS n FROM catalogue_item WHERE catalogue_id=?", args: [id] })).rows[0].n;
      assert.equal(n, 25, "at the ceiling (25): unresolved lines count and are saved");
      await p2.goto(`${app.base}/audit`, { waitUntil: "networkidle" });
      rows.push("F-26,shirt,China,26");
      await p2.fill("textarea", rows.join("\n"));
      await p2.getByRole("button", { name: "Run audit" }).click();
      await p2.getByRole("alert").filter({ hasText: /26 products exceeds the 25/ }).waitFor({ timeout: 15000 });
    } finally { await c2.close(); }
  });

  // ---- deleting -----------------------------------------------------------

  await check("deleting is an explicit confirmation that says it stops watching codes", async () => {
    await page.goto(`${app.base}/catalogues`, { waitUntil: "networkidle" });
    const watchedBefore = (await db.execute({ sql: "SELECT count(*) AS n FROM watched_code WHERE catalogue_id=?", args: [catalogueId] })).rows[0].n;
    assert.ok(watchedBefore >= 1);
    await page.getByRole("link", { name: /^Delete Review range/ }).click();
    await page.waitForURL(/delete=/);
    const dialog = page.getByRole("alertdialog");
    assert.match(await dialog.innerText(), /also stops watching the 1 code it added/);
    assert.equal((await db.execute({ sql: "SELECT count(*) AS n FROM catalogue WHERE id=?", args: [catalogueId] })).rows[0].n, 1, "asking deletes nothing");
    await page.getByRole("link", { name: "Keep it" }).click();
    await page.waitForURL((u) => !u.search);
    assert.equal(await page.getByRole("alertdialog").count(), 0);
    assert.equal((await db.execute({ sql: "SELECT count(*) AS n FROM catalogue WHERE id=?", args: [catalogueId] })).rows[0].n, 1);

    await page.getByRole("link", { name: /^Delete Review range/ }).click();
    await page.getByRole("button", { name: /Delete catalogue and stop watching its codes/ }).click();
    await page.getByRole("alertdialog").waitFor({ state: "detached", timeout: 10000 });
    assert.equal((await db.execute({ sql: "SELECT count(*) AS n FROM catalogue WHERE id=?", args: [catalogueId] })).rows[0].n, 0);
    assert.equal((await db.execute({ sql: "SELECT count(*) AS n FROM watched_code WHERE catalogue_id=?", args: [catalogueId] })).rows[0].n, 0);
  });

  // ---- layout -------------------------------------------------------------

  await check("results do not scroll the page sideways on a phone", async () => {
    const { ctx: c3, page: p3 } = await newPage(app.base, token, { width: 390, height: 844 });
    try {
      await p3.goto(`${app.base}/audit`, { waitUntil: "networkidle" });
      await runOn(p3, MIXED);
      await p3.locator("tbody tr").first().getByRole("button", { name: /Details/ }).click();
      const overflow = await p3.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 2, `horizontal overflow of ${overflow}px`);
      if (SHOTS) await p3.screenshot({ path: path.join(SHOTS, "audit-390.png"), fullPage: true });
      // The saved catalogue too: a visually hidden label inside the scrolling
      // table once stretched the whole page sideways.
      await p3.fill('input[placeholder*="Autumn"]', "Phone range");
      await Promise.all([
        p3.waitForURL(/\/catalogues\/[0-9a-f-]{36}/, { timeout: 30000 }),
        p3.getByRole("button", { name: "Save and watch these codes" }).click(),
      ]);
      await p3.locator("tbody tr").first().waitFor();
      const saved = await p3.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(saved <= 2, `saved catalogue overflows by ${saved}px`);
    } finally { await c3.close(); }
  });

  if (SHOTS) {
    await check("screenshots", async () => {
      const { ctx: c4, page: p4 } = await newPage(app.base, token, { width: 1440, height: 1000 });
      try {
        await p4.goto(`${app.base}/audit`, { waitUntil: "networkidle" });
        await runOn(p4, MIXED);
        await p4.locator("tbody tr", { hasText: "scope shirt" }).getByRole("button", { name: /Details/ }).click();
        await p4.screenshot({ path: path.join(SHOTS, "audit-1440.png"), fullPage: true });
      } finally { await c4.close(); }
    });
  }

  await check("no page errors during the session", () => assert.deepEqual(page.errors, []));
} finally {
  await ctx.close().catch(() => {});
  await browser.close().catch(() => {});
  db.close();
  await app.stop().catch(() => {});
  await fake.close();
}

// ---- signing not configured -------------------------------------------------

const bare = suite();
const fake2 = await fakeServer(3342, async (req, res) => json(res, 200, auditResponse(JSON.parse(await readBody(req)))));
const app2 = await startApp({ port: 3312, env: { HTSDESK_API: "http://127.0.0.1:3342", HTSDESK_API_KEY: "k",
  HTSDESK_ADMIN_TOKEN: "", HTSDESK_EMAIL_SECRET: "", HTSDESK_SIGNING_SECRET: "" } });
const db2 = app2.db();
const browser2 = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
try {
  const tok = crypto.randomBytes(16).toString("hex");
  await seedAccount(db2, { id: "nosign", plan: "growth" });
  await db2.execute({ sql: "INSERT INTO session(token, account_id, expires_at) VALUES(?,?,?)",
    args: [tok, "nosign", new Date(Date.now() + 3_600_000).toISOString()] });
  const c = await browser2.newContext();
  await c.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await c.addCookies([{ name: "htsdesk_session", value: tok, url: app2.base }]);
  const p = await c.newPage();
  await bare.check("with signing unconfigured in production, results show but saving reports it is unavailable", async () => {
    await p.goto(`${app2.base}/audit`, { waitUntil: "networkidle" });
    await p.fill("textarea", "sku,description,country,value\nA,shirt,China,100");
    await p.getByRole("button", { name: "Run audit" }).click();
    await p.locator('[data-testid="reconciliation"]').waitFor({ timeout: 15000 });
    await p.fill('input[placeholder*="Autumn"]', "Nope");
    await p.getByRole("button", { name: "Save and watch these codes" }).click();
    await p.locator('p[role="alert"]').waitFor({ timeout: 10000 });
    assert.match(await p.locator('p[role="alert"]').innerText(), /Saving is unavailable: signing is not configured/);
    assert.equal((await db2.execute("SELECT count(*) AS n FROM catalogue WHERE name='Nope'")).rows[0].n, 0);
    assert.match(app2.log(), /signing is unavailable|saving is unavailable/i);
  });
} finally {
  await browser2.close().catch(() => {});
  db2.close();
  await app2.stop().catch(() => {});
  await fake2.close();
}

const a = finish();
const b = bare.finish();
process.exit(a || b);
