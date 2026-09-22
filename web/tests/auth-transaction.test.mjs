import assert from "node:assert/strict";
import crypto from "node:crypto";
import { chromium } from "playwright-core";
import { startApp } from "./harness.mjs";
const app = await startApp({ port: 3484, env: { SITE_URL: "http://127.0.0.1:3484", HTSDESK_API: "http://127.0.0.1:3499" } });
const db = app.db();
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
try {
  const before = "fixture-before-long-passphrase", after = "fixture-after-long-passphrase";
  const salt = crypto.randomBytes(16);
  const hash = `scrypt$${salt.toString("hex")}$${crypto.scryptSync(before, salt, 64, { N: 16384, r: 8, p: 1 }).toString("hex")}`;
  await db.execute({ sql: "INSERT INTO account(id,email,password_hash,created_at) VALUES(?,?,?,?)", args: ["owner", "owner@example.test", hash, new Date().toISOString()] });
  const old = await browser.newContext();
  const oldPage = await old.newPage();
  await oldPage.goto(app.base + "/login", { waitUntil: "networkidle" });
  await oldPage.getByLabel("Email", { exact: true }).fill("owner@example.test");
  await oldPage.getByLabel("Password", { exact: true }).fill(before);
  await oldPage.getByRole("button", { name: "Sign in", exact: true }).click();
  await oldPage.waitForURL(app.base + "/account");
  const token = crypto.randomBytes(32).toString("base64url");
  await db.execute({ sql: "INSERT INTO auth_token(token_hash,kind,account_id,email,created_at,expires_at) VALUES(?,?,?,?,?,?)", args: [crypto.createHash("sha256").update(token).digest("hex"), "password_reset", "owner", "owner@example.test", new Date().toISOString(), "2099-01-01T00:00:00.000Z"] });
  const reset = await browser.newContext();
  const resetPage = await reset.newPage();
  await resetPage.goto(app.base + "/reset?token=" + token, { waitUntil: "networkidle" });
  await resetPage.getByLabel("New password", { exact: true }).fill(after);
  await resetPage.getByRole("button", { name: "Set new password", exact: true }).click();
  await resetPage.waitForURL(app.base + "/account");
  // A same-origin fetch run from inside the page, not context.request: the
  // session cookie is Secure, and Chromium only exempts *page* traffic to a
  // loopback origin from the Secure-requires-HTTPS rule, not Playwright's
  // separate Node-side API-request client, which would wrongly withhold the
  // cookie here and read as "logged out" regardless of whether the session
  // is actually valid.
  const statusFrom = (page, url) => page.evaluate((u) => fetch(u).then((r) => r.status), url);
  assert.equal(await statusFrom(oldPage, app.base + "/api/catalogues/evidence?id=missing"), 401, "the previous browser session is revoked");
  assert.equal(await statusFrom(resetPage, app.base + "/api/catalogues/evidence?id=missing"), 404, "the reset browser gets a valid new session");
  await resetPage.goto(app.base + "/reset?token=" + token);
  await resetPage.getByRole("heading", { name: "That link is no longer valid" }).waitFor();
  const fresh = await browser.newContext();
  const page = await fresh.newPage();
  await page.goto(app.base + "/login", { waitUntil: "networkidle" });
  await page.getByLabel("Email", { exact: true }).fill("owner@example.test");
  await page.getByLabel("Password", { exact: true }).fill(before);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "do not match" }).waitFor();
  await page.getByLabel("Password", { exact: true }).fill(after);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(app.base + "/account");
  await Promise.all([old.close(), reset.close(), fresh.close()]);
  console.log("Authentication browser checks passed: login, reset, old-session revocation, single-use link, old-password rejection and new-password login.");
} finally { await browser.close(); db.close(); await app.stop(); }
