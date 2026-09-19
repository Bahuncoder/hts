/** Security regressions for the account, catalogue and export surfaces.
 *
 *  Every case here corresponds to something found by attacking a running
 *  instance. They exist so it cannot come back.
 *
 *  Needs the API and web app running: node tests/security.test.mjs
 */
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { BASE, newContext, signUp } from "./helpers.mjs";

/** Fonts are fetched from Google on every fresh context. They change nothing
 *  about behaviour and make navigation waits flaky when the network is slow,
 *  so they are refused outright. */
async function blockWebfonts(ctx) {
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
}

async function newPage() {
  const c = await b.newContext();
  await blockWebfonts(c);
  return c.newPage();
}


const PASSWORD = "a-perfectly-fine-passphrase";
const results = [];

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
  args: ["--no-sandbox"],
});

async function check(name, fn) {
  try { await fn(); results.push([name, null]); }
  catch (e) { results.push([name, e.message]); }
}

async function makeUser(tag) {
  const { ctx, page, email } = await signUp(browser, tag, { acceptDownloads: true });
  return { ctx, page, email };
}

async function saveCatalogue(user, name, rows) {
  await user.page.goto(`${BASE}/audit`, { waitUntil: "networkidle" });
  await user.page.fill("textarea", ["sku,description,country,value,hts", ...rows].join("\n"));
  await user.page.click("text=Run audit");
  await user.page.waitForSelector("table", { timeout: 90000 });
  await user.page.fill('input[placeholder*="Autumn"]', name);
  await user.page.click("text=Save and watch these codes");
  await user.page.waitForURL(/\/catalogues\/[0-9a-f-]{36}/, { timeout: 30000 });
  return user.page.url().split("/").pop();
}

const victim = await makeUser("victim");
const catId = await saveCatalogue(victim, "Victim private catalogue",
  ["SECRET-1,confidential silicon metal lump,Norway,120000,"]);
const attacker = await makeUser("attacker");

// --- authorisation ----------------------------------------------------------

await check("one customer cannot read another's catalogue", async () => {
  await attacker.page.goto(`${BASE}/catalogues/${catId}`, { waitUntil: "networkidle" });
  const body = await attacker.page.locator("body").innerText();
  assert.ok(!/confidential silicon|Victim private/i.test(body),
    "catalogue contents leaked across accounts");
});

await check("one customer cannot export another's catalogue", async () => {
  const res = await attacker.ctx.request.get(`${BASE}/api/catalogues/export?id=${catId}`);
  assert.notEqual(res.status(), 200);
  assert.ok(!/confidential silicon/i.test(await res.text()), "export leaked across accounts");
});

await check("a missing catalogue is indistinguishable from someone else's", async () => {
  const theirs = await attacker.ctx.request.get(`${BASE}/api/catalogues/export?id=${catId}`);
  const nothing = await attacker.ctx.request.get(
    `${BASE}/api/catalogues/export?id=00000000-0000-0000-0000-000000000000`);
  assert.equal(theirs.status(), nothing.status(),
    "a different status confirms the catalogue exists");
});

await check("signed-out visitors cannot reach account pages", async () => {
  const ctx = await newContext(browser);
  await blockWebfonts(ctx);
  const page = await ctx.newPage();
  for (const path of ["/account", "/catalogues", "/alerts"]) {
    await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
    assert.match(page.url(), /\/login/, `${path} was reachable signed out`);
  }
  await ctx.close();
});

// --- session ----------------------------------------------------------------

await check("the session cookie is httpOnly, secure and same-site", async () => {
  const c = (await victim.ctx.cookies()).find((x) => x.name.includes("session"));
  assert.ok(c, "no session cookie");
  assert.equal(c.httpOnly, true, "readable from JavaScript");
  assert.equal(c.secure, true, "would travel over plain http");
  assert.match(c.sameSite, /Lax|Strict/, "sent on cross-site requests");
});

await check("the session token is not reachable from page scripts", async () => {
  const visible = await victim.page.evaluate(() => document.cookie);
  assert.ok(!/session/i.test(visible), `document.cookie exposes: ${visible}`);
});

// --- credentials ------------------------------------------------------------

await check("sign-in is throttled against guessing", async () => {
  const ctx = await newContext(browser);
  await blockWebfonts(ctx);
  const page = await ctx.newPage();
  let allowed = 0;
  for (let i = 0; i < 14; i++) {
    await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
    await page.fill("input[name=email]", victim.email);
    await page.fill("input[name=password]", `wrong-guess-number-${i}`);
    await page.click("button[type=submit]");
    await page.waitForTimeout(220);
    const msg = await page.locator("form p").first().innerText().catch(() => "");
    if (/too many/i.test(msg)) break;
    allowed++;
  }
  await ctx.close();
  assert.ok(allowed <= 10, `${allowed} unthrottled guesses — brute force is open`);
});

await check("a failed sign-in does not reveal whether the email exists", async () => {
  const ctx = await newContext(browser);
  await blockWebfonts(ctx);
  const page = await ctx.newPage();
  const read = async (email) => {
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
    await page.fill("input[name=email]", email);
    await page.fill("input[name=password]", "some-wrong-password-here");
    await page.click("button[type=submit]");
    await page.waitForTimeout(1200);
    return page.locator("form p").first().innerText().catch(() => "");
  };
  const known = await read(attacker.email);
  const unknown = await read(`nobody-${Date.now()}@example.test`);
  await ctx.close();
  assert.equal(known, unknown, "the message differs by whether the account exists");
});

// --- export -----------------------------------------------------------------

await check("CSV export neutralises spreadsheet formulas", async () => {
  const user = await makeUser("csvsec");
  await saveCatalogue(user, "Formula check", [
    `INJ-1,"=cmd|' /C calc'!A1",China,1000,`,
    `INJ-3,"@SUM(1+1)",China,1000,`,
    `OK-1,ordinary cotton shirt,China,1000,`,
  ]);
  const [dl] = await Promise.all([
    user.page.waitForEvent("download", { timeout: 20000 }),
    user.page.click("text=Export CSV"),
  ]);
  const stream = await dl.createReadStream();
  let csv = ""; for await (const chunk of stream) csv += chunk;
  await user.ctx.close();

  // Columns are found by header, not position: the export has gained a leading
  // Row column, and a fixed index would silently test the wrong cell.
  const rows = csv.replace(/^\ufeff/, "").split("\r\n").filter(Boolean)
    .map((l) => l.slice(1, -1).split('","'));
  const col = rows[0].indexOf("Description");
  assert.ok(col >= 0, "no Description column");
  const inj = rows.slice(1).filter((r) => /^INJ-/.test(r[rows[0].indexOf("SKU")] ?? ""));
  assert.equal(inj.length, 2, "the injected rows must reach the export");
  for (const r of inj) {
    for (const cell of r) {
      assert.ok(!/^[=+@\t\r]/.test(cell),
        `a spreadsheet would evaluate this cell: ${JSON.stringify(cell.slice(0, 40))}`);
    }
    assert.ok(/^'/.test(r[col]), "the leading character is neutralised, not dropped");
  }
  assert.match(csv, /"1000\.00"/, "numeric values must not be mangled by the escaping");
});

await check("markup in a product description is not executed", async () => {
  await victim.page.goto(`${BASE}/audit`, { waitUntil: "networkidle" });
  await victim.page.fill("textarea", [
    "sku,description,country,value,hts",
    'XSS-1,"<img src=x onerror=window.__pwned=1>cotton shirt",China,1000,',
  ].join("\n"));
  await victim.page.click("text=Run audit");
  await victim.page.waitForSelector("table", { timeout: 60000 });
  assert.equal(await victim.page.evaluate(() => window.__pwned), undefined);
});

// --- admin ------------------------------------------------------------------

await check("admin endpoints refuse a signed-in customer", async () => {
  for (const path of ["/api/admin/diff", "/api/admin/email-preview?account=x"]) {
    const res = path.includes("diff")
      ? await attacker.ctx.request.post(`${BASE}${path}`)
      : await attacker.ctx.request.get(`${BASE}${path}`);
    assert.equal(res.status(), 401, `${path} was reachable by a customer`);
  }
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
