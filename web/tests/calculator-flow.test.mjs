/** Calculator journey, in a real browser: an empty calculator, switching to
 *  "Find a code" without any fields filled, picking a result, calculating, and
 *  switching modes without running an estimate.
 *
 *  Starts its own production server on a spare port with a scratch accounts
 *  database (harness.mjs). The duty engine must be running on
 *  HTSDESK_API (default 127.0.0.1:8099).
 *  Run: node tests/calculator-flow.test.mjs
 */
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { startApp, suite } from "./harness.mjs";

const app = await startApp({ port: 3488 });
const t = suite();
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const estimate = () => page.locator('[aria-label="Estimate"]').count();

try {
  await page.goto(`${app.base}/calculator`, { waitUntil: "networkidle", timeout: 120000 });

  await t.check("an empty form can switch to Find a code (no required-field block)", async () => {
    await page.getByRole("button", { name: "Find a code" }).click();
    await page.waitForURL(/mode=find/, { timeout: 60000 });
    await page.waitForLoadState("networkidle");
    assert.equal(await page.locator("#find-code").count(), 1);
  });

  let picked;
  await t.check("searching lists candidates and picking one fills the code, with no estimate", async () => {
    await page.locator("#find-code input[name=q]").fill("cotton t-shirt men");
    await page.locator("#find-code").getByRole("button", { name: "Search" }).click();
    const first = page.locator('ul[aria-labelledby="matches-label"] a').first();
    await first.waitFor({ timeout: 60000 });
    picked = (await first.innerText()).trim();
    await Promise.all([page.waitForURL(/mode=code/, { timeout: 60000 }), first.click()]);
    await page.waitForLoadState("networkidle");
    assert.equal(await page.locator("#hts").inputValue(), picked);
    assert.equal(await estimate(), 0);
  });

  await t.check("Calculate, with origin and value, runs the estimate and drops the mode", async () => {
    await page.locator("#country").fill("China");
    await page.locator("#value").fill("10000");
    await Promise.all([page.waitForURL((u) => !u.search.includes("mode="), { timeout: 60000 }), page.getByRole("button", { name: "Calculate", exact: true }).click()]);
    await page.waitForLoadState("networkidle");
    assert.equal(await estimate(), 1);
  });

  await t.check("switching modes keeps typed values and runs no estimate", async () => {
    await page.getByRole("button", { name: "I know my code" }).click();
    await page.waitForLoadState("networkidle");
    assert.equal(await page.locator("#hts").inputValue(), picked);
    assert.equal(await page.locator("#value").inputValue(), "10000");
    assert.equal(await estimate(), 0);
    await page.getByRole("button", { name: "Find a code" }).click();
    await page.waitForLoadState("networkidle");
    assert.equal(await page.locator("#find-code").count(), 1);
    assert.equal(await estimate(), 0);
  });

  await t.check("an unknown code gets one message", async () => {
    await page.getByRole("button", { name: "I know my code" }).click();
    await page.waitForLoadState("networkidle");
    await page.locator("#hts").fill("6109.10.00.99");
    await Promise.all([page.waitForURL((u) => !u.search.includes("mode="), { timeout: 60000 }), page.getByRole("button", { name: "Calculate", exact: true }).click()]);
    await page.waitForLoadState("networkidle");
    const alerts = (await page.locator('[role="alert"]').allInnerTexts()).filter((a) => a.trim());
    assert.equal(alerts.length, 1, JSON.stringify(alerts));
  });

  await t.check("no page errors", async () => {
    assert.deepEqual(errors, []);
  });
} finally {
  await browser.close();
  await app.stop?.();
}
const code = t.finish();
process.exit(code);
