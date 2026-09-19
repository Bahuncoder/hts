/** UI regression checks against a production build and scratch accounts only.
 * Run: node tests/ui-workspace.test.mjs
 * Optional HTSDESK_SHOTS writes desktop/mobile screenshots for review.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { fakeServer, json, readBody, seedAccount, startApp, suite } from "./harness.mjs";
import { auditResponse } from "./auditfixture.mjs";

const fake = await fakeServer(3379, async (req, res) => {
  if (req.url.startsWith("/api/health")) return json(res, 200, { status: "ok", hts_edition: "fixture", counts: { hts: 19949, ruling: 200962, ch99_rule: 565, ch99_scope: 12362 } });
  if (req.url.startsWith("/api/audit")) return json(res, 200, auditResponse(JSON.parse(await readBody(req))));
  return json(res, 200, { changes: [], count: 0 });
});
const app = await startApp({ port: 3378, env: { HTSDESK_API: "http://127.0.0.1:3379", HTSDESK_API_KEY: "test-key" } });
const db = app.db();
await seedAccount(db, { id: "ui-reviewer" });
const token = crypto.randomBytes(32).toString("hex");
await db.execute({ sql: "INSERT INTO session(token, account_id, expires_at) VALUES(?,?,?)", args: [token, "ui-reviewer", new Date(Date.now() + 3600000).toISOString()] });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
await ctx.addCookies([{ name: "htsdesk_session", value: token, url: app.base }]);
const page = await ctx.newPage();
page.setDefaultTimeout(10000);
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const { check, finish } = suite();
const shots = process.env.HTSDESK_SHOTS;
if (shots) fs.mkdirSync(shots, { recursive: true });
const shot = async (name) => { if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true }); };
const csv = "sku,description,country,value,hts\nSMALL,ready shirt,China,100,6109.10.00.12\nLARGE,scope shirt,Vietnam,2000,6109.10.00.12\nMID,ready bag,Germany,500,6109.10.00.12";
const rows = () => page.locator("tbody tr").filter({ has: page.getByRole("button", { name: /Details|Hide details/ }) });

try {
  await check("home exposes the three working tools and clearly labels its illustration", async () => {
    await page.goto(app.base);
    await page.getByRole("heading", { name: /Know the code/ }).waitFor();
    assert.equal(await page.getByRole("link", { name: /^Audit your catalogue/ }).getAttribute("href"), "/audit");
    assert.match(await page.locator("main").innerText(), /Illustration only/);
    await shot("home-desktop");
  });
  await check("audit retains row identity when searching and sorting", async () => {
    await page.goto(`${app.base}/audit`);
    await page.getByLabel("Your catalogue", { exact: true }).fill(csv);
    await page.getByRole("button", { name: "Run audit", exact: true }).click();
    await page.getByRole("heading", { name: "Review the details." }).waitFor();
    assert.equal(await rows().count(), 3);
    await page.getByLabel("Sort results").selectOption("duty");
    assert.match(await rows().first().innerText(), /LARGE/);
    await page.getByLabel("Find a product").fill("Germany");
    assert.equal(await rows().count(), 1);
    assert.match(await rows().first().innerText(), /MID/);
    await page.getByLabel("Find a product").fill("no-such-product");
    await page.getByRole("button", { name: "Clear search and filters" }).click();
    assert.equal(await rows().count(), 3);
    await page.getByRole("button", { name: /^Needs review \(/ }).click();
    assert.equal(await rows().count(), 1);
    await rows().first().getByRole("button", { name: /Details/ }).click();
    assert.match(await page.locator("tr.bg-sunk").innerText(), /scope verification/);
    await page.getByRole("button", { name: /^All \(/ }).click();
    await shot("audit-desktop");
  });
  await check("changing shipping assumptions prevents saving an outdated result", async () => {
    const save = page.getByRole("button", { name: "Save and watch these codes" });
    assert.equal(await save.isDisabled(), false);
    await page.locator("summary").filter({ hasText: /^Assumptions: / }).click();
    await page.getByLabel("Transport", { exact: true }).selectOption("air");
    assert.equal(await save.isDisabled(), true);
    assert.match(await page.locator("main").innerText(), /changed the catalogue or shipping assumptions/);
    await page.getByRole("button", { name: "Run audit", exact: true }).click();
    await page.waitForFunction(() => !Array.from(document.querySelectorAll("button")).find((b) => b.textContent.includes("Save and watch"))?.disabled);
    assert.equal(await save.isDisabled(), false);
  });
  await check("mobile and dark layouts contain overflow within the results table", async () => {
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `page overflow at ${width}px`);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(200); // let the control color transitions settle
    const colors = await page.locator(".btn-secondary").first().evaluate((el) => ({ background: getComputedStyle(el).backgroundColor, foreground: getComputedStyle(el).color, surface: getComputedStyle(el).getPropertyValue("--surface").trim() }));
    assert.equal(colors.background, "rgb(20, 29, 26)", "dark secondary controls use the dark surface token");
    assert.equal(colors.foreground, "rgb(232, 239, 236)");
    await shot("audit-mobile-dark");
    await page.locator("summary").filter({ hasText: "Explore tools" }).click();
    const current = page.locator('nav:visible a[aria-current="page"]');
    assert.equal(await current.innerText(), "Catalogue audit");
    await page.emulateMedia({ colorScheme: "light" });
  });
  await check("calculator and sign-in use labeled fields without page overflow", async () => {
    await page.goto(`${app.base}/calculator`);
    assert.equal(await page.getByLabel("Entered value (USD)", { exact: true }).getAttribute("step"), "0.01");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await shot("calculator-mobile");
    await ctx.clearCookies();
    await page.goto(`${app.base}/login`);
    await page.getByRole("heading", { name: /Sign in/ }).waitFor();
    assert.equal(await page.getByLabel("Email", { exact: true }).count(), 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await shot("login-mobile");
  });
  await check("no browser runtime errors", () => assert.deepEqual(errors, []));
} finally {
  await browser.close();
  db.close();
  await app.stop();
  await fake.close();
}
process.exitCode = finish();
