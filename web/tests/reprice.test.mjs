/** Re-pricing a saved catalogue: resubmits each line's own code/description
 *  and stated facts to the engine again, in place. Drives the real browser
 *  UI (save, approve, re-price) against a fake engine whose second response
 *  deliberately differs from its first, so "the rate actually moved" is
 *  something the test controls precisely, not a fixture coincidence.
 *
 *  Safety: a scratch accounts database in a fresh temp directory, never
 *  data/accounts.db. Run: node tests/reprice.test.mjs
 */
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { startApp, fakeServer, json, readBody, seedAccount } from "./harness.mjs";

const PORT = 3493;
const ENGINE_PORT = 3494;

let auditCalls = 0;
const requestsSeen = [];

const engine = await fakeServer(ENGINE_PORT, async (req, res) => {
  if (req.url === "/api/audit" && req.method === "POST") {
    const body = JSON.parse(await readBody(req));
    auditCalls += 1;
    requestsSeen.push(body);
    const call = auditCalls;
    const lines = body.items.map((it, idx) => {
      const base = { row: it.row ?? idx + 1, sku: it.sku, description: it.description, country: it.country };
      if (it.sku === "changed") {
        const rate = call === 1 ? 0.165 : 0.30; // the "rate move" the re-price should pick up
        const duty = Math.round(it.value * rate * 100) / 100;
        return { ...base, hts: "6109.10.00.12", confidence: "given", status: "ready",
          review_reasons: [], warnings: [], incomplete: [], scope_unverified: [],
          entered_value: it.value, duty, effective_rate_pct: rate * 100, refundable: 0 };
      }
      if (it.sku === "stable") {
        const duty = Math.round(it.value * 0.165 * 100) / 100;
        return { ...base, hts: "6109.10.00.12", confidence: "given", status: "ready",
          review_reasons: [], warnings: [], incomplete: [], scope_unverified: [],
          entered_value: it.value, duty, effective_rate_pct: 16.5, refundable: 0 };
      }
      // "improves": unclassified on the first pass, resolvable on the second —
      // as if the ruling corpus or the classifier had improved meanwhile.
      if (call === 1) {
        return { ...base, hts: null, status: "unclassified", error_code: "no_candidate",
          error: "Could not classify this product from its description.",
          review_reasons: ["Could not classify this product from its description."],
          warnings: [], incomplete: [], scope_unverified: [], suggested: [] };
      }
      return { ...base, hts: "6109.10.00.55", confidence: "high", status: "ready",
        review_reasons: [], warnings: [], incomplete: [], scope_unverified: [],
        entered_value: it.value, duty: Math.round(it.value * 0.165 * 100) / 100,
        effective_rate_pct: 16.5, refundable: 0,
        suggested: [{ hts: "6109.10.00.55", reasoning: "Newly resolvable",
          rulings: [{ ruling: "N999999", subject: "Fresh fixture ruling", date: "2026-01-01",
            revoked: false, url: "https://rulings.cbp.gov/ruling/N999999", excerpt: "Fresh evidence text." }] }] };
    });
    const priced = lines.filter((l) => l.status !== "unclassified");
    const value = priced.reduce((a, l) => a + (l.entered_value ?? 0), 0);
    const duty = Math.round(priced.reduce((a, l) => a + (l.duty ?? 0), 0) * 100) / 100;
    const mpf = value > 0 ? 33.58 * (body.entries ?? 1) : 0;
    const unresolved = lines.filter((l) => l.status !== "ready").length;
    return json(res, 200, {
      summary: {
        submitted: lines.length, items: lines.length, processed: lines.length, priced: priced.length,
        unresolved, by_status: {}, truncated: false, totals_complete: unresolved === 0,
        entered_value: value, duty_and_hmf: duty, mpf, duty: Math.round((duty + mpf) * 100) / 100,
        effective_rate_pct: value ? Math.round(((duty + mpf) / value) * 10000) / 100 : 0,
        potentially_refundable: 0, unclassified: lines.filter((l) => l.status === "unclassified").length,
        needs_scope_review: 0,
        assumptions: [`The priced value is spread over ${body.entries ?? 1} formal entr${(body.entries ?? 1) === 1 ? "y" : "ies"}.`,
          body.by_vessel === false ? "Non-vessel shipment." : "Vessel shipment."],
        dataset_revision: `rev-${call}`,
      },
      lines,
    });
  }
  return json(res, 200, { changes: [], has_more: false, next_cursor: null });
});

const app = await startApp({ port: PORT, env: { HTSDESK_API: `http://127.0.0.1:${ENGINE_PORT}`, SITE_URL: `http://127.0.0.1:${PORT}` } });
const db = app.db();
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
try {
  await seedAccount(db, { id: "owner" });
  await db.execute({ sql: "INSERT INTO session VALUES(?,?,?)", args: ["owner-session", "owner", "2099-01-01T00:00:00.000Z"] });
  const context = await browser.newContext();
  await context.addCookies([{ name: "htsdesk_session", value: "owner-session", domain: "127.0.0.1", path: "/" }]);
  const page = await context.newPage();

  await page.goto(app.base + "/audit", { waitUntil: "networkidle" });
  await page.getByLabel("Your catalogue", { exact: true }).fill(
    "sku,description,country,value\nchanged,cotton shirt A,China,1000\nstable,cotton shirt B,China,1000\nimproves,cotton shirt C,China,1000");
  await page.getByText(/^Assumptions:/).click(); // the entries/transport fields live in a closed <details>
  await page.getByLabel("Formal entries", { exact: true }).fill("3");
  await page.getByLabel("Transport", { exact: true }).selectOption("air");
  await page.getByRole("button", { name: "Run audit", exact: true }).click();
  await page.getByLabel("Save as", { exact: true }).fill("Reprice fixture");
  await page.getByRole("button", { name: "Save and watch these codes" }).click();
  await page.waitForURL(/\/catalogues\/[^/]+$/);
  const id = new URL(page.url()).pathname.split("/").at(-1);

  const cat = await db.execute({ sql: "SELECT entries, by_vessel FROM catalogue WHERE id = ?", args: [id] });
  assert.equal(cat.rows[0].entries, 3, "the entered entries count is what got saved");
  assert.equal(cat.rows[0].by_vessel, 0, "air transport is saved as by_vessel = 0");

  const before = (await db.execute({
    sql: "SELECT id, sku, hts, duty, status, evidence_json FROM catalogue_item WHERE catalogue_id = ? ORDER BY row_number",
    args: [id],
  })).rows;
  const changedItem = before.find((r) => r.sku === "changed");
  const stableItem = before.find((r) => r.sku === "stable");
  const improvesItem = before.find((r) => r.sku === "improves");
  assert.equal(changedItem.duty, 165, "sanity: first-pass rate is 16.5%");
  assert.equal(improvesItem.status, "unclassified");
  assert.equal(JSON.parse(improvesItem.evidence_json).source, "no_classifier_evidence");

  // Approve the line that is about to change, so the test can check it gets
  // reopened — and the one that will NOT change, so the test can check it
  // does not. The review workspace lives on the catalogue page itself, with
  // a "Product line" selector for which line the form below it acts on.
  await page.goto(`${app.base}/catalogues/${id}`, { waitUntil: "networkidle" });
  for (const it of [changedItem, stableItem]) {
    await page.getByLabel("Product line", { exact: true }).selectOption(it.id);
    await page.getByLabel("Review action", { exact: true }).selectOption("approve");
    await page.getByLabel("Reason or comment").fill(`Approved ${it.sku} before re-price.`);
    await page.getByRole("button", { name: "Record review", exact: true }).click();
    await page.getByText("Review recorded.", { exact: true }).waitFor();
  }

  assert.equal(auditCalls, 1, "sanity: only the original audit has run so far");
  await page.getByRole("button", { name: "Re-price with current rates", exact: true }).click();
  await page.waitForURL(new RegExp(`/catalogues/${id}\\?repriced=1`));
  assert.equal(auditCalls, 2);
  assert.equal(requestsSeen[1].entries, 3, "re-price resubmits the saved entries count, not the audit form's default of 1");
  assert.equal(requestsSeen[1].by_vessel, false, "re-price resubmits the saved transport, not the default vessel");
  assert.equal(requestsSeen[1].items.find((i) => i.sku === "changed").hts, "6109.10.00.12",
    "re-price resubmits the line's own code rather than re-classifying it from scratch");

  const banner = await page.getByText(/Re-priced against/).innerText();
  assert.match(banner, /2 of 3 lines changed/);

  const after = (await db.execute({
    sql: "SELECT id, sku, hts, duty, status, approval_status, evidence_json FROM catalogue_item WHERE catalogue_id = ? ORDER BY row_number",
    args: [id],
  })).rows;
  const changedAfter = after.find((r) => r.sku === "changed");
  const stableAfter = after.find((r) => r.sku === "stable");
  const improvesAfter = after.find((r) => r.sku === "improves");

  assert.equal(changedAfter.duty, 300, "the changed line picked up the new rate");
  assert.equal(changedAfter.approval_status, "pending", "an approval built on the old price is reopened");
  assert.equal(stableAfter.duty, 165, "the stable line's price did not move");
  assert.equal(stableAfter.approval_status, "approved", "an approval whose price did not move is left alone");
  assert.equal(improvesAfter.status, "ready", "the never-classified line was classified on re-price");
  assert.equal(improvesAfter.hts, "6109.10.00.55");
  assert.equal(JSON.parse(improvesAfter.evidence_json).rulings[0].excerpt, "Fresh evidence text.",
    "a line with no prior code gets the fresh evidence, not a blank placeholder");

  const stableEvidenceBefore = before.find((r) => r.sku === "stable").evidence_json;
  assert.equal(after.find((r) => r.sku === "stable").evidence_json, stableEvidenceBefore,
    "a line that already had a code keeps its existing evidence rather than being overwritten with none");

  const history = (await db.execute({
    sql: "SELECT actor, comment FROM catalogue_item_event WHERE item_id = ? ORDER BY created_at", args: [changedItem.id],
  })).rows;
  assert.ok(history.some((h) => h.actor.includes("Re-price") && h.comment.includes("165") && h.comment.includes("300")),
    "the reopen is recorded in the line's own history, naming the old and new figures");

  console.log("Re-price: rate move picked up, unchanged line and its approval left alone, "
    + "never-classified line resolved with fresh evidence, entries/transport resubmitted correctly, "
    + "reopen recorded in history.");
} finally {
  await browser.close();
  await engine.close();
  db.close();
  await app.stop();
}
