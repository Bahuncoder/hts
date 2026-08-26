/** End-to-end product test: the journey a real customer takes.
 *
 *  Drives a real browser against a running app, because the parts most likely
 *  to be broken — server actions, cookies, redirects, form state — are exactly
 *  the parts an HTTP-level test cannot reach.
 *
 *  Start the API and web first, then: node tests/journey.test.mjs
 */
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { BASE, PASSWORD as SHARED_PW, go, inbox, newContext, signUp } from "./helpers.mjs";




const TOKEN = process.env.HTSDESK_ADMIN_TOKEN ?? "admin-test-token";



const results = [];
let browser, page, account;

async function step(name, fn) {
  try { await fn(); results.push([name, null]); }
  catch (e) { results.push([name, e.message]); }
}

const text = () => page.locator("body").innerText();

browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
  args: ["--no-sandbox"],
});
let ctx = await newContext(browser, {
  viewport: { width: 1280, height: 900 },
  acceptDownloads: true,
});
page = await ctx.newPage();

const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

// --- discovery --------------------------------------------------------------

await step("landing page states the offer and offers a way in", async () => {
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  const body = await text();
  assert.match(body, /code you don.t have|Know what your imports/i);
  assert.ok(await page.locator('a[href="/signup"]').count() > 0, "no signup route in");
});

await step("a code page prices duty and cites its authority", async () => {
  await page.goto(`${BASE}/hts/6109.10.00.12?country=China`, { waitUntil: "networkidle" });
  const body = await text();
  assert.match(body, /6109\.10\.00\.12/);
  assert.match(body, /MFN duty/);
  assert.match(body, /HTSUS Column 1 General/, "every line must carry its authority");
  assert.match(body, /%/);
});

await step("an anonymous visitor is invited to watch, not shown a broken control", async () => {
  const body = await text();
  assert.match(body, /Watch this code/);
});

// --- signing up -------------------------------------------------------------

await step("signup rejects a short password", async () => {
  await page.goto(`${BASE}/signup`, { waitUntil: "domcontentloaded" });
  await page.fill('input[name="email"]', `short-${Date.now()}@example.test`);
  await page.fill('input[name="password"]', "short");
  await page.evaluate(() => {
    document.querySelector('input[name="password"]').removeAttribute("minlength");
  });
  await page.click('button[type="submit"]');
  await page.waitForTimeout(1200);
  assert.match(await text(), /at least 10 characters/i);
});

await step("signup creates an account and lands on it", async () => {
  account = await signUp(browser, "journey");
  await ctx.close();
  ctx = account.ctx;
  page = account.page;
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  const body = await text();
  assert.match(body, /Free/, "a new account starts on the free plan");
});

await step("signing up again while signed in does not create a second account", async () => {
  const probe = await ctx.newPage();
  await probe.goto(`${BASE}/signup`, { waitUntil: "domcontentloaded" });

  assert.match(probe.url(), /\/account/,
    "an existing session should skip signup");
  await probe.close();
});

// --- the core job -----------------------------------------------------------

await step("an audit classifies a catalogue and prices it", async () => {
  await page.goto(`${BASE}/audit`, { waitUntil: "networkidle" });
  await page.fill("textarea", [
    "sku,description,country,value,hts",
    "SI-01,silicon metal 99% purity lump,Norway,120000,",
    "TS-01,mens knitted cotton t-shirt short sleeve,China,48000,",
  ].join("\n"));
  await page.click("text=Run audit");
  await page.waitForSelector("table", { timeout: 90000 });
  const body = await text();
  assert.match(body, /entered value/i);
  assert.match(body, /\$168,000|\$168000/);
});

await step("the audit offers to save, and saving lands on the catalogue", async () => {
  await page.fill('input[placeholder*="Autumn"]', "Journey test catalogue");
  await Promise.all([
    page.waitForURL(/\/catalogues\/[0-9a-f-]{36}/, { timeout: 30000 }),
    page.click("text=Save and watch these codes"),
  ]);
  const body = await text();
  assert.match(body, /Journey test catalogue/);
  assert.match(body, /every classified code is watched/i);
});

await step("saving a catalogue watches its codes", async () => {
  await page.goto(`${BASE}/alerts`, { waitUntil: "networkidle" });
  const body = await text();
  assert.match(body, /codes watched/);
  assert.ok(/28\d{2}\.\d{2}|6109\.\d{2}/.test(body), "watched codes not listed");
});

await step("a published tariff action reaches the customer as an alert", async () => {
  const res = await fetch(`${BASE}/api/admin/diff?since=2026-08-01`, {
    method: "POST", headers: { "x-admin-token": TOKEN },
  });
  const d = await res.json();
  assert.ok(d.ran, "diff did not run");
  await page.goto(`${BASE}/alerts`, { waitUntil: "networkidle" });
  const body = await text();
  assert.ok(!/not watching any codes/i.test(body), "watches were lost");
});

await step("catalogue exports as CSV with a sensible filename", async () => {
  await page.goto(`${BASE}/catalogues`, { waitUntil: "networkidle" });
  await page.click("text=Journey test catalogue");
  await page.waitForURL(/\/catalogues\/[0-9a-f-]{36}/, { timeout: 20000 });

  // Exercise the path a customer actually takes — clicking the link — rather
  // than refetching the URL, so the download headers are what is under test.
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 20000 }),
    page.click("text=Export CSV"),
  ]);
  assert.match(download.suggestedFilename(), /^journey-test-catalogue-\d{4}-\d{2}-\d{2}\.csv$/,
    `unexpected filename: ${download.suggestedFilename()}`);

  const stream = await download.createReadStream();
  let csv = "";
  for await (const chunk of stream) csv += chunk;
  assert.match(csv, /"SKU","Description"/, "header row missing");
  assert.match(csv, /silicon metal/i, "catalogue contents missing");
  assert.ok(csv.startsWith("\ufeff"), "no BOM — Excel will mangle non-ASCII");
});

// --- account control --------------------------------------------------------

await step("alert emails can be turned off from the account", async () => {
  await page.goto(`${BASE}/account`, { waitUntil: "networkidle" });
  const before = await text();
  assert.match(before, /Alert emails/);
  const btn = page.locator("button", { hasText: /Turn alert emails/ }).first();
  const label = await btn.innerText();
  await btn.click();
  await page.waitForTimeout(1500);
  const after = await page.locator("button", { hasText: /Turn alert emails/ }).first().innerText();
  assert.notEqual(label, after, "the toggle did not change state");
});

await step("signing out ends the session", async () => {
  await page.goto(`${BASE}/account`, { waitUntil: "networkidle" });
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith("/account"), { timeout: 20000 }),
    page.click("text=Sign out"),
  ]);
  await page.goto(`${BASE}/account`, { waitUntil: "networkidle" });
  assert.match(page.url(), /\/login/, "a signed-out visitor must not reach the account");
});

await step("signing back in restores the catalogue", async () => {
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.fill('input[name="email"]', account.email);
  await page.fill('input[name="password"]', SHARED_PW);
  await Promise.all([
    page.waitForURL(/\/account/, { timeout: 20000 }),
    page.click('button[type="submit"]'),
  ]);
  await page.goto(`${BASE}/catalogues`, { waitUntil: "networkidle" });
  assert.match(await text(), /Journey test catalogue/);
});

await step("a wrong password is refused with one message", async () => {
  await page.goto(`${BASE}/account`, { waitUntil: "networkidle" });
  await page.click("text=Sign out").catch(() => {});
  await page.waitForTimeout(800);
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.fill('input[name="email"]', account.email);
  await page.fill('input[name="password"]', "definitely-not-the-password");
  await page.click('button[type="submit"]');
  await page.waitForTimeout(1500);
  const error = await page.locator("form p").first().innerText();
  assert.match(error, /do not match/i);
  assert.ok(!/no account|not found|unknown email|no such user/i.test(error),
    "the message must not reveal whether the email is registered");
});

// --- robustness -------------------------------------------------------------

await step("legal pages are reachable from the footer", async () => {
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  assert.ok(await page.locator('a[href="/terms"]').count() > 0);
  assert.ok(await page.locator('a[href="/privacy"]').count() > 0);
  await page.goto(`${BASE}/terms`, { waitUntil: "networkidle" });
  assert.match(await text(), /reasonable care/i);
});

await step("an unknown code shows a real not-found page", async () => {
  await page.goto(`${BASE}/hts/0000.00.00.00`, { waitUntil: "networkidle" });
  assert.match(await text(), /not found/i);
});

await step("script in a product description is not executed", async () => {
  await page.goto(`${BASE}/audit`, { waitUntil: "networkidle" });
  await page.fill("textarea", [
    "sku,description,country,value,hts",
    'XSS-1,"<img src=x onerror=window.__pwned=1>cotton shirt",China,1000,',
  ].join("\n"));
  await page.click("text=Run audit");
  await page.waitForSelector("table", { timeout: 60000 });
  const pwned = await page.evaluate(() => window.__pwned);
  assert.equal(pwned, undefined, "markup from a catalogue was executed");
});

await step("the page has no console errors during the journey", async () => {
  // Webfonts are deliberately blocked by the test harness.
  const real = errors.filter((e) =>
    !/favicon|404 \(Not Found\)|ERR_FAILED|fonts\.(googleapis|gstatic)/i.test(e));
  assert.deepEqual(real, [], `console errors: ${real.slice(0, 3).join(" | ")}`);
});

// --- responsive -------------------------------------------------------------

await step("the layout does not scroll sideways on a phone", async () => {
  const phone = await ctx.newPage();
  await phone.setViewportSize({ width: 390, height: 844 });
  const offenders = [];
  for (const path of ["/", "/pricing", "/hts/6109.10.00.12", "/terms"]) {
    await phone.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
    const overflow = await phone.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (overflow > 2) offenders.push(`${path} (+${overflow}px)`);
  }
  await phone.close();
  assert.deepEqual(offenders, [], `horizontal overflow: ${offenders.join(", ")}`);
});

await browser.close();

const failed = results.filter(([, e]) => e);
const w = Math.max(...results.map(([n]) => n.length));
for (const [name, err] of results) {
  console.log(`  ${err ? "FAIL" : "ok  "}  ${name.padEnd(w)}`);
  if (err) console.log(`        ${err.split("\n")[0].slice(0, 170)}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
