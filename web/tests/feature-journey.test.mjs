/** Full browser workflow against production routes and an isolated fake engine. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { startApp, fakeServer, json, readBody, seedAccount, scratchDir } from "./harness.mjs";
import { auditResponse } from "./auditfixture.mjs";
const engine = await fakeServer(3492, async (req, res) => {
  if (req.url === "/api/audit") {
    const result = auditResponse(JSON.parse(await readBody(req)));
    for (const line of result.lines) for (const c of line.suggested ?? []) for (const r of c.rulings ?? []) r.excerpt = "Saved fixture ruling excerpt about cotton material.";
    return json(res, 200, result);
  }
  return json(res, 200, { changes: [], has_more: false, next_cursor: null });
});
const app = await startApp({ port: 3482, env: { HTSDESK_API: "http://127.0.0.1:3492", SITE_URL: "http://127.0.0.1:3482" } });
const db = app.db();
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
try {
  await seedAccount(db, { id: "owner" });
  await seedAccount(db, { id: "other" });
  for (const id of ["owner", "other"]) await db.execute({ sql: "INSERT INTO session VALUES(?,?,?)", args: [id + "-session", id, "2099-01-01T00:00:00.000Z"] });
  const context = await browser.newContext();
  await context.addCookies([{ name: "htsdesk_session", value: "owner-session", domain: "127.0.0.1", path: "/" }]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(app.base + "/audit", { waitUntil: "networkidle" });
  await page.getByLabel("Your catalogue", { exact: true }).fill("sku,description,country,value,hts\nA,ready cotton shirt,China,100,\nB,ready cotton garment,China,300,");
  await page.getByRole("button", { name: "Run audit", exact: true }).click();
  await page.getByRole("button", { name: /Estimate landed cost/ }).click();
  await page.getByLabel("Additional-cost currency").selectOption("EUR");
  await page.getByLabel("USD per 1 EUR").fill("1.25");
  await page.getByLabel("Rate date").fill("2026-09-22");
  await page.getByLabel("Rate source").fill("Fixture bank quote");
  await page.getByLabel("Freight (EUR)", { exact: true }).fill("10");
  await page.getByLabel("Save as", { exact: true }).fill("Verified feature journey");
  await page.getByRole("button", { name: "Save and watch these codes" }).click();
  await page.waitForURL(/\/catalogues\/[^/]+$/);
  const id = new URL(page.url()).pathname.split("/").at(-1);
  const saved = await db.execute({ sql: "SELECT landed_cost_json FROM catalogue WHERE id = ?", args: [id] });
  assert.equal(JSON.parse(saved.rows[0].landed_cost_json).usdRate, 1.25);
  const lines = (await db.execute({ sql: "SELECT * FROM catalogue_item WHERE catalogue_id = ? ORDER BY row_number", args: [id] })).rows;
  assert.equal(JSON.parse(lines[0].evidence_json).rulings[0].excerpt, "Saved fixture ruling excerpt about cotton material.");
  const before = await (await page.request.get(app.base + "/api/catalogues/evidence?id=" + id)).json();
  assert.equal(before.landed_cost.landed, 512.08);
  assert.equal(before.per_product_allocation.reduce((n, l) => n + Math.round(l.additional_costs * 100), 0), 1250);
  await page.getByLabel("Freight (EUR)", { exact: true }).fill("20");
  await page.getByRole("button", { name: "Save import costs", exact: true }).click();
  await page.getByText("Import costs saved. Exports now include these amounts.").waitFor();
  await page.reload({ waitUntil: "networkidle" });
  assert.equal(await page.getByLabel("Freight (EUR)", { exact: true }).inputValue(), "20");
  // Human review lives entirely on the dedicated /review page now (the
  // catalogue page's ReviewWorkspace is a status summary + link only). A
  // second tab opened on the same item BEFORE this approval still carries
  // the pre-approval review_version in its form, so submitting it afterward
  // is a real, browser-driven version-conflict race, not a raw API poke.
  const stalePage = await context.newPage();
  await stalePage.goto(`${app.base}/catalogues/${id}/review?item=${lines[0].id}`, { waitUntil: "networkidle" });
  await page.goto(`${app.base}/catalogues/${id}/review?item=${lines[0].id}`, { waitUntil: "networkidle" });
  await page.locator('select[name="approval_status"]').selectOption("approved");
  await page.locator('input[name="note"]').fill("Checked material and the saved ruling excerpt.");
  await page.getByRole("button", { name: "Record decision", exact: true }).click();
  await page.waitForFunction(() => document.body.textContent.includes("Checked material and the saved ruling excerpt."));
  assert.match(await page.locator("body").innerText(), /Approved: 1/);

  await stalePage.locator('select[name="approval_status"]').selectOption("approved");
  await stalePage.locator('input[name="note"]').fill("stale decision");
  await Promise.all([
    stalePage.waitForURL(/notice=conflict/),
    stalePage.getByRole("button", { name: "Record decision", exact: true }).click(),
  ]);
  await stalePage.close();
  await page.locator('input[name="assigned_to"]').fill("broker@example.test");
  await page.getByRole("button", { name: "Save assignment", exact: true }).click();
  await page.getByText("assigned it to broker@example.test", { exact: false }).waitFor();
  const exported = await (await page.request.get(app.base + "/api/catalogues/evidence?id=" + id)).json();
  assert.equal(exported.landed_cost.landed, 524.58);
  assert.equal(exported.review_history.length, 2);
  assert.equal(exported.review_history[0].actor_email, "owner@example.test");
  assert.equal(exported.review_history[1].assigned_to, "broker@example.test");
  assert.equal(exported.review.lines[0].human_review_status, "approved");
  await page.goto(`${app.base}/catalogues/${id}/report`, { waitUntil: "networkidle" });
  assert.match(await page.locator("body").innerText(), /Saved fixture ruling excerpt/);
  assert.match(await page.locator("body").innerText(), /Fixture bank quote/);
  const pdf = path.join(scratchDir("evidence-pdf-"), "evidence.pdf");
  await page.pdf({ path: pdf, format: "A4", printBackground: true });
  assert.ok(fs.statSync(pdf).size > 1000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${app.base}/catalogues/${id}`, { waitUntil: "networkidle" });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, "mobile page should not overflow horizontally");
  assert.deepEqual(errors, []);
  const other = await browser.newContext();
  await other.addCookies([{ name: "htsdesk_session", value: "other-session", domain: "127.0.0.1", path: "/" }]);
  const denied = await other.request.get(`${app.base}/api/catalogues/evidence?id=${id}`);
  assert.equal(denied.status(), 404);
  await other.close(); await context.close();
  console.log("Browser journey passed: audit → FX costs → signed evidence save → reopen/edit → allocation export → approve → assignment/history → PDF → mobile → account isolation.");
} finally { await browser.close(); db.close(); await app.stop(); await engine.close(); }
