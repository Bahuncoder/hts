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
import { HEALTH_WITHOUT_COUNTS, HEALTH_WITH_COUNTS, htsFixture } from "./enginefixture.mjs";

const fake = await fakeServer(3379, async (req, res) => {
  if (req.url.startsWith("/api/health")) return json(res, 200, HEALTH_WITH_COUNTS);
  if (req.url.startsWith("/api/audit")) return json(res, 200, auditResponse(JSON.parse(await readBody(req))));
  if (req.url.startsWith("/api/hts/")) {
    const url = new URL(req.url, "http://x");
    return json(res, 200, htsFixture(decodeURIComponent(url.pathname.split("/").pop()), url.searchParams.get("country") ?? "China"));
  }
  return json(res, 200, { changes: [], count: 0 });
});
// The same app against an engine that answers health WITHOUT row counts (they
// are only returned to a keyed caller), for the evidence block.
const fakeBare = await fakeServer(3381, async (req, res) => json(res, 200, HEALTH_WITHOUT_COUNTS));
const appBare = await startApp({ port: 3380, env: { HTSDESK_API: "http://127.0.0.1:3381", HTSDESK_API_KEY: "test-key" } });
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
    // "Free to start" is a readable pill beside the buttons, not fine print.
    const beta = page.getByText("Free to start", { exact: true });
    await beta.waitFor();
    assert.ok(parseFloat(await beta.evaluate((el) => getComputedStyle(el).fontSize)) >= 14, "at least 14px");
    const [b, primary] = await Promise.all([beta.boundingBox(), page.getByRole("link", { name: /^Audit your catalogue/ }).boundingBox()]);
    assert.ok(Math.abs((b.y + b.height / 2) - (primary.y + primary.height / 2)) < 30, "beside the primary button");
    // With counts, the numbers show.
    assert.match(await page.locator("#evidence-title").locator("xpath=../..").innerText(), /19,949/);
    await shot("home-desktop");
  });
  await check("home shows no 'Unavailable' figures when the engine returns no row counts", async () => {
    const p = await ctx.newPage();
    try {
      await p.goto(appBare.base);
      await p.getByRole("heading", { name: "Every figure needs context." }).waitFor();
      const block = p.locator("#evidence-title").locator("xpath=../..");
      const text = await block.innerText();
      assert.doesNotMatch(text, /Unavailable/);
      assert.equal(await block.locator("dl").count(), 0, "no numbers grid");
      assert.match(text, /Sources: USITC, CBP, and the Federal Register/);
      assert.match(text, /Reference edition: fixture/);
    } finally { await p.close(); }
  });
  await check("a file with unrecognised headings can be matched by hand, and the preview shows what will be read", async () => {
    await page.goto(`${app.base}/audit`);
    await page.getByLabel("Your catalogue", { exact: true }).fill("Product Name,Ctry,Price\nmens knitted cotton t-shirt,China,4800\nceramic coffee mug,Germany,1200");
    await page.waitForTimeout(500);
    assert.match(await page.locator("body").innerText(), /Missing the “description” column/, "the missing column is named");
    await page.locator("select").nth(0).selectOption({ label: "Product Name" });
    await page.locator("select").nth(1).selectOption({ label: "Ctry" });
    await page.locator("select").nth(2).selectOption({ label: "Price" });
    await page.waitForTimeout(500);
    const text = await page.locator("body").innerText();
    assert.match(text, /2 rows read/, "the two rows are read once mapped");
    assert.match(text, /mens knitted cotton t-shirt/, "the preview shows the mapped description");
    assert.doesNotMatch(text, /Missing the “description” column/, "the problem clears once mapped");
  });
  await check("the results headline offers one action to the lines that need attention", async () => {
    await page.goto(`${app.base}/audit`);
    await page.getByLabel("Your catalogue", { exact: true }).fill(csv);
    await page.getByRole("button", { name: "Run audit", exact: true }).click();
    await page.getByRole("heading", { name: "Review the details." }).waitFor();
    assert.match(await page.locator("main").innerText(), /products need attention/);
    await page.getByRole("button", { name: /^Review the \d+ to confirm$/ }).click();
    assert.equal(await page.getByRole("button", { name: /^Needs review/ }).getAttribute("aria-pressed"), "true");
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
  await check("after a run the import folds into a summary bar so results start above the fold", async () => {
    const bar = page.getByTestId("import-summary");
    await bar.waitFor();
    assert.match(await bar.innerText(), /3 products · 1 formal entry · vessel shipment · audited/);
    assert.equal(await page.getByLabel("Your catalogue", { exact: true }).count(), 0, "the form is folded away");
    assert.equal(await page.getByRole("button", { name: "Run audit" }).count(), 0, "one Run button, only while editing");
    await page.evaluate(() => window.scrollTo(0, 0));
    const heading = await page.getByRole("heading", { name: "Review the details." }).boundingBox();
    assert.ok(heading.y < 700, `results heading starts at ${heading.y}px; it must be above a 1000px fold with room to read`);
    // Editing reopens it, filled, with Run reachable; Collapse folds it back.
    await bar.getByRole("button", { name: "Edit catalogue" }).click();
    assert.match(await page.getByLabel("Your catalogue", { exact: true }).inputValue(), /SMALL/);
    assert.equal(await page.getByRole("button", { name: "Run audit", exact: true }).isEnabled(), true);
    assert.equal(await page.getByTestId("import-summary").count(), 0);
    await page.getByRole("button", { name: "Collapse" }).click();
    await page.getByTestId("import-summary").waitFor();
    // Keyboard: focus lands on the summary, and the button is reachable from it.
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-testid")), "import-summary");
  });
  await check("changing shipping assumptions prevents saving an outdated result", async () => {
    const save = page.getByRole("button", { name: "Save and watch these codes" });
    assert.equal(await save.isDisabled(), false);
    await page.getByRole("button", { name: "Edit catalogue" }).click();
    await page.locator("summary").filter({ hasText: /^Assumptions: / }).click();
    await page.getByLabel("Transport", { exact: true }).selectOption("air");
    assert.equal(await save.isDisabled(), true);
    assert.match(await page.locator("main").innerText(), /changed the catalogue or shipping assumptions/);
    await page.getByRole("button", { name: "Run audit", exact: true }).click();
    await page.waitForFunction(() => !Array.from(document.querySelectorAll("button")).find((b) => b.textContent.includes("Save and watch"))?.disabled);
    assert.equal(await save.isDisabled(), false);
  });
  await check("changing a column choice after an audit makes its results outdated", async () => {
    const save = page.getByRole("button", { name: "Save and watch these codes" });
    assert.equal(await save.isDisabled(), false);
    await page.getByRole("button", { name: "Edit catalogue" }).click();
    const mapper = page.locator("details").filter({ hasText: "Match your columns" });
    if (!(await mapper.evaluate((el) => el.open))) await mapper.locator("summary").click();
    await mapper.locator("select").first().selectOption({ label: "Not in my file" });
    assert.equal(await save.isDisabled(), true, "a changed mapping must block saving the old results");
    assert.match(await page.locator("main").innerText(), /changed the catalogue or shipping assumptions/);
    await mapper.locator("select").first().selectOption({ label: "description" });
    await page.getByRole("button", { name: "Run audit", exact: true }).click();
    await page.waitForFunction(() => !Array.from(document.querySelectorAll("button")).find((b) => b.textContent.includes("Save and watch"))?.disabled);
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
  await check("code page: a readable title, its path, remedies split by origin, even stat cards", async () => {
    await page.setViewportSize({ width: 1440, height: 1000 }); // the earlier checks left a phone width
    await page.goto(`${app.base}/hts/6109.10.00.12?country=China`, { waitUntil: "networkidle" });
    // A fragment description ("Men's (338)") gets a title from its nearest two ancestors.
    assert.equal(await page.getByTestId("hts-title").innerText(), "Men's or boys' › Other T-shirts");
    assert.equal(await page.getByTestId("hts-line-description").innerText(), "Men's (338)");
    assert.match(await page.title(), /^HTS 6109\.10\.00\.12 — Men's or boys' › Other T-shirts \| duty rate from China/);
    const path = page.getByRole("navigation", { name: "Classification path" });
    const segments = await path.locator("li").allInnerTexts();
    assert.equal(segments.length, 5);
    assert.match(segments[0], /^T-shirts, singlets/);
    assert.match(segments.at(-1), /Men's \(338\)$/);
    assert.equal(await path.locator('[aria-current="location"]').innerText(), "Men's (338)");

    // Remedies: those that apply to China first; the rest collapsed.
    const remedies = page.locator("section", { has: page.getByRole("heading", { name: "Trade remedies covering this code" }) });
    assert.equal(await remedies.getByRole("heading", { name: "Apply to China" }).count(), 1);
    const other = page.getByTestId("other-remedies");
    assert.equal(await other.evaluate((el) => el.open), false, "collapsed by default");
    assert.match(await other.locator("summary").innerText(), /^Also cover this code for other origins \(2\)$/);
    assert.equal(await page.getByText("9903.01.10", { exact: true }).isVisible(), false, "a Canada-only remedy is not on show under a China quote");
    assert.equal(await page.getByText("9903.88.03", { exact: true }).first().isVisible(), true);
    const applying = await remedies.locator("h3").locator("xpath=..").innerText();
    assert.match(applying, /9903\.88\.03/); assert.match(applying, /9903\.01\.24/);
    assert.doesNotMatch(applying, /9903\.01\.10|9903\.01\.32/);
    await other.locator("summary").click();
    assert.equal(await page.getByText("9903.01.10", { exact: true }).isVisible(), true);
    // For another origin the split follows the API's flag, not the page's guess.
    await page.goto(`${app.base}/hts/6109.10.00.12?country=Canada`, { waitUntil: "networkidle" });
    assert.match(await page.getByRole("heading", { name: "Apply to Canada" }).innerText(), /Apply to Canada/);

    // Stat cards: one height, contents from the top; the reasons sit under all three.
    await page.goto(`${app.base}/hts/6109.10.00.12?country=China`, { waitUntil: "networkidle" });
    const cards = page.locator(".grid.sm\\:grid-cols-3 > .panel");
    assert.equal(await cards.count(), 3);
    const boxes = await cards.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
    assert.ok(Math.max(...boxes) - Math.min(...boxes) < 2, `card heights ${boxes.join(", ")}`);
    const cardText = (await cards.allInnerTexts()).join(" ");
    assert.doesNotMatch(cardText, /understated because/, "the reasons are not squeezed into one card");
    assert.match(await page.locator("main").innerText(), /The total is understated because/);
    assert.match(await cards.nth(2).innerText(), /Scenario estimate for an entry like this, not a claim amount/);

    // Warning and recovery are different colour families.
    const hue = (rgb) => {
      const [r, g, b] = rgb.match(/\d+/g).slice(0, 3).map((v) => v / 255);
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
      const h = d === 0 ? 0 : mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return ((h * 60) + 360) % 360;
    };
    const warn = await page.getByText("Estimate is incomplete").first().evaluate((el) => getComputedStyle(el).color);
    const recover = await cards.nth(2).locator(".mono").evaluate((el) => getComputedStyle(el).color);
    const stat = await cards.nth(1).locator(".mono").evaluate((el) => getComputedStyle(el).color);
    assert.equal(stat, warn, "an incomplete figure uses the caution colour");
    assert.ok(Math.abs(hue(warn) - hue(recover)) >= 20, `caution (${warn}) and recover (${recover}) must be different hues`);
    await shot("code-page");
  });
  await check("fonts are self-hosted: a page load makes no request to Google", async () => {
    const seen = [];
    const fresh = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const p = await fresh.newPage();
    p.on("request", (r) => seen.push(r.url()));
    try {
      // Recorded, NOT blocked: the other checks block font hosts, which would hide a regression.
      for (const path of ["/", "/audit", "/hts/6109.10.00.12", "/login", "/privacy"]) {
        await p.goto(`${app.base}${path}`, { waitUntil: "networkidle" });
      }
      const hosts = seen.map((u) => { try { return new URL(u).hostname; } catch { return ""; } });
      const google = seen.filter((u, i) => /(^|\.)(googleapis|gstatic)\.com$/.test(hosts[i]));
      assert.deepEqual(google, [], "no request to googleapis/gstatic");
      assert.ok(seen.length > 5, "requests were recorded");
      assert.ok(seen.some((u) => /\/_next\/static\/media\/.+\.woff2/.test(u) && u.startsWith(app.base)), "font files come from our own origin");
      await p.goto(app.base, { waitUntil: "networkidle" });
      const loaded = await p.evaluate(() => document.fonts.ready.then(() => [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family)));
      for (const family of [/IBM[ _]Plex[ _]Sans/, /IBM[ _]Plex[ _]Mono/, /Newsreader/]) {
        assert.ok(loaded.some((f) => family.test(f)), `${family} loaded: ${loaded.join(", ")}`);
      }
      assert.equal(await p.locator('link[href*="fonts.googleapis"], link[href*="fonts.gstatic"]').count(), 0);
      assert.match(await p.evaluate(() => getComputedStyle(document.body).fontFamily), /IBM[ _]Plex[ _]Sans/);
      await p.goto(`${app.base}/privacy`);
      assert.doesNotMatch(await p.locator("main").innerText(), /Google/, "the privacy page has nothing to say about Google");
    } finally { await fresh.close(); }
  });
  await check("no browser runtime errors", () => assert.deepEqual(errors, []));
} finally {
  await browser.close();
  db.close();
  await app.stop();
  await appBare.stop();
  await fake.close();
  await fakeBare.close();
}
process.exitCode = finish();
