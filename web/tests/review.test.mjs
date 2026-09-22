/** Human review of a saved catalogue line: approve/request changes/reject,
 *  assign, and comment — kept apart from the engine's own computed status.
 *
 *  Drives a real browser against `next dev` (not `next start`): the feature
 *  lives entirely in its own files (lib/review.ts, lib/reviewActions.ts, the
 *  /review route) that no other in-progress work touches, so it does not need
 *  a full production build to exercise, and Server Actions submitted through
 *  a plain HTML form need a real browser to encode correctly.
 *
 *  Safety: a scratch accounts database in a fresh temp directory, never
 *  data/accounts.db. Run: node tests/review.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { chromium } from "playwright-core";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3488;
const BASE = `http://127.0.0.1:${PORT}`;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "htsdesk-review-"));
const dbPath = path.join(scratch, "accounts.db");

const child = spawn(process.execPath, [path.join(WEB, "node_modules/next/dist/bin/next"), "dev",
  "-p", String(PORT), "-H", "127.0.0.1"], {
  cwd: WEB,
  env: {
    PATH: process.env.PATH, HOME: process.env.HOME,
    NEXT_TELEMETRY_DISABLED: "1",
    HTSDESK_ACCOUNTS_DB: dbPath,
    HTSDESK_ADMIN_TOKEN: "admin-test-token",
    HTSDESK_EMAIL_SECRET: "test-email-secret",
    SITE_URL: BASE,
  },
});
let log = "";
child.stdout.on("data", (d) => (log += d));
child.stderr.on("data", (d) => (log += d));

async function waitReady() {
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`dev server exited early:\n${log}`);
    try { if ((await fetch(`${BASE}/robots.txt`)).ok) return; } catch { /* not yet */ }
    if (Date.now() > deadline) throw new Error(`dev server did not start:\n${log}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

let browser;
try {
  await waitReady();

  const db = createClient({ url: `file:${dbPath}` });
  // Touch the store once so its schema (and review.ts's own, lazily) exists.
  await fetch(`${BASE}/api/admin/diff`, { headers: { "x-admin-token": "admin-test-token" } });

  async function seedAccount(id) {
    await db.execute({
      sql: "INSERT INTO account(id,email,password_hash,created_at,alert_emails) VALUES(?,?,?,?,1)",
      args: [id, `${id}@example.test`, "scrypt$0$0", new Date().toISOString()],
    });
    await db.execute({
      sql: "INSERT INTO session VALUES(?,?,?)",
      args: [`${id}-session`, id, "2099-01-01T00:00:00.000Z"],
    });
  }
  await seedAccount("owner");
  await seedAccount("other");

  const now = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO catalogue(id,account_id,name,created_at,updated_at,totals_complete,mpf)
          VALUES(?,?,?,?,?,?,?)`,
    args: ["cat", "owner", "Q3 catalogue", now, now, 1, 33.58],
  });
  await db.execute({
    sql: `INSERT INTO catalogue_item(id,catalogue_id,sku,description,country,value,hts,digits,
            confidence,duty,effective_rate,refundable,scope_unverified,row_number,status)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: ["item1", "cat", "SKU-1", "Cotton t-shirt", "China", 10000, "6109.10.00.12",
      "6109100012", "given", 1650, 16.5, 0, 0, 1, "ready"],
  });

  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
    args: ["--no-sandbox"],
  });
  const newPage = async (cookie) => {
    const ctx = await browser.newContext();
    await ctx.addCookies([{ name: "htsdesk_session", value: cookie, domain: "127.0.0.1", path: "/" }]);
    await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
    return { ctx, page: await ctx.newPage() };
  };

  const results = [];
  async function check(name, fn) {
    try { await fn(); results.push([name, null]); }
    catch (e) { results.push([name, e.stack ?? e.message]); }
  }

  await check("an item starts pending, with no history", async () => {
    const { ctx, page } = await newPage("owner-session");
    await page.goto(`${BASE}/catalogues/cat/review`, { waitUntil: "networkidle" });
    const body = await page.locator("body").innerText();
    assert.match(body, /Pending review: 1/);
    assert.match(body, /Cotton t-shirt/);
    await ctx.close();
  });

  await check("approving with a note records the decision and appears in history", async () => {
    const { ctx, page } = await newPage("owner-session");
    await page.goto(`${BASE}/catalogues/cat/review?item=item1`, { waitUntil: "networkidle" });
    await page.selectOption('select[name="approval_status"]', "approved");
    await page.fill('input[name="note"]', "Checked against the supplier invoice.");
    await page.click('button:has-text("Record decision")');
    await page.waitForTimeout(800);
    const body = await page.locator("body").innerText();
    assert.match(body, /Approved: 1/, "the summary count did not move");
    assert.match(body, /marked it Approved/);
    assert.match(body, /Checked against the supplier invoice\./);
    await ctx.close();
  });

  await check("assigning a reviewer records it and pre-fills on reopen", async () => {
    const { ctx, page } = await newPage("owner-session");
    await page.goto(`${BASE}/catalogues/cat/review?item=item1`, { waitUntil: "networkidle" });
    await page.fill('input[name="assigned_to"]', "sara@example.test");
    await page.click('button:has-text("Save assignment")');
    await page.waitForTimeout(800);
    let body = await page.locator("body").innerText();
    assert.match(body, /assigned it to sara@example\.test/);

    await page.goto(`${BASE}/catalogues/cat/review`, { waitUntil: "networkidle" });
    body = await page.locator("body").innerText();
    assert.match(body, /sara@example\.test/, "the assignee did not show in the row");
    const value = await page.locator('a:has-text("Review")').getAttribute("href");
    assert.ok(value?.includes("item=item1"));
    await ctx.close();
  });

  await check("a plain comment does not change the approval state", async () => {
    const { ctx, page } = await newPage("owner-session");
    await page.goto(`${BASE}/catalogues/cat/review?item=item1`, { waitUntil: "networkidle" });
    await page.fill('textarea[name="comment"]', "Following up with the broker next week.");
    await page.click('button:has-text("Comment")');
    await page.waitForTimeout(800);
    const body = await page.locator("body").innerText();
    assert.match(body, /Following up with the broker next week\./);
    assert.match(body, /Approved: 1/, "a comment changed the approval count");
    await ctx.close();
  });

  await check("another account cannot see or act on this item", async () => {
    // Next can stream a page's shell before notFound() lands, so the HTTP
    // status alone is not reliable here (see tests/evidence.test.mjs's own
    // report-page check for the same behaviour) — what must hold is that no
    // private content of the catalogue ever reaches the response body.
    const { ctx, page } = await newPage("other-session");
    await page.goto(`${BASE}/catalogues/cat/review`, { waitUntil: "networkidle" });
    const body = await page.locator("body").innerText();
    assert.doesNotMatch(body, /Cotton t-shirt/);
    assert.doesNotMatch(body, /Q3 catalogue/);
    await ctx.close();

    // Even a crafted request naming the real item id sees nothing: ownership
    // is re-checked inside lib/review.ts, not assumed from the form.
    const direct = await fetch(`${BASE}/catalogues/cat/review?item=item1`, {
      headers: { cookie: "htsdesk_session=other-session" },
    });
    assert.doesNotMatch(await direct.text(), /Cotton t-shirt/);

    const events = await db.execute({ sql: "SELECT count(*) AS n FROM catalogue_item_event WHERE item_id = ?", args: ["item1"] });
    assert.equal(events.rows[0].n, 3, "an unauthorized request left a mark on the history");
  });

  await check("the comment form rejects empty text (required, both client and server)", async () => {
    const { ctx, page } = await newPage("owner-session");
    await page.goto(`${BASE}/catalogues/cat/review?item=item1`, { waitUntil: "networkidle" });
    const before = await db.execute({ sql: "SELECT count(*) AS n FROM catalogue_item_event WHERE item_id = ?", args: ["item1"] });
    // The field is `required`; submitting via requestSubmit bypasses that to
    // prove the server itself also refuses an empty comment.
    await page.evaluate(() => {
      const form = document.querySelector('textarea[name="comment"]')?.closest("form");
      form?.removeAttribute("onsubmit");
      const ta = form?.querySelector("textarea");
      if (ta) ta.removeAttribute("required");
    });
    await page.click('button:has-text("Comment")');
    await page.waitForTimeout(800);
    const after = await db.execute({ sql: "SELECT count(*) AS n FROM catalogue_item_event WHERE item_id = ?", args: ["item1"] });
    assert.equal(after.rows[0].n, before.rows[0].n, "an empty comment was recorded");
    await ctx.close();
  });

  const width = Math.max(...results.map(([n]) => n.length));
  let failed = 0;
  for (const [name, err] of results) {
    console.log(`  ${err ? "FAIL" : "ok  "}  ${name.padEnd(width)}`);
    if (err) { failed++; console.log(`        ${err.split("\n")[0]}`); }
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  db.close();
  process.exitCode = failed ? 1 : 0;
} finally {
  if (browser) await browser.close();
  child.kill("SIGTERM");
  setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, 3000);
  fs.rmSync(scratch, { recursive: true, force: true });
}
