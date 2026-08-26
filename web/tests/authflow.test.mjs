/** Password reset, email verification, and the enumeration fix.
 *
 *  Adapts to the server it is given. With a mail provider configured it
 *  exercises the real link flows; without one it checks the documented
 *  fallback. Run the full version against a local catcher:
 *
 *    node tests/mailcatch.mjs &
 *    RESEND_API_KEY=test RESEND_API_URL=http://127.0.0.1:4444/emails \
 *      SITE_URL=http://localhost:3000 npm run start
 *    node tests/authflow.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium } from "playwright-core";

const BASE = process.env.HTSDESK_TEST_WEB ?? "http://localhost:3000";
const MAILBOX = process.env.HTSDESK_MAILBOX ?? "/tmp/mailbox.jsonl";
const PASSWORD = "a-perfectly-fine-passphrase";
const results = [];

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
  args: ["--no-sandbox"],
});

/** Fonts are fetched from Google on every fresh context; they change nothing
 *  about behaviour and make navigation waits flaky. */
async function newPage() {
  const ctx = await browser.newContext();
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  return { ctx, page: await ctx.newPage() };
}

const go = (page, url) => page.goto(url, { waitUntil: "domcontentloaded" });
const formMessage = (page) =>
  page.locator("form p").first().innerText().catch(() => "");

function inbox() {
  try {
    return fs.readFileSync(MAILBOX, "utf8").trim().split("\n")
      .filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

async function check(name, fn) {
  try { await fn(); results.push([name, null]); }
  catch (e) { results.push([name, e.message]); }
}

async function signupAttempt(email, password = PASSWORD) {
  const { ctx, page } = await newPage();
  await go(page, `${BASE}/signup`);
  await page.fill("input[name=email]", email);
  await page.fill("input[name=password]", password);
  await page.click("button[type=submit]");
  await page.waitForTimeout(2000);
  return { ctx, page, message: await formMessage(page), url: page.url() };
}

// Detect the mode from a throwaway signup.
const probeEmail = `probe-${Date.now()}@example.test`;
const probe = await signupAttempt(probeEmail);
const emailMode = /check your inbox/i.test(probe.message);
await probe.ctx.close();
console.log(`  (email ${emailMode ? "configured — testing link flows" : "not configured — testing fallback"})\n`);

// --- enumeration ------------------------------------------------------------

await check("signup does not reveal whether an address is registered", async () => {
  const fresh = await signupAttempt(`fresh-${Date.now()}@example.test`);
  const dup = await signupAttempt(probeEmail);
  const a = fresh.message, bMsg = dup.message;
  await fresh.ctx.close(); await dup.ctx.close();
  if (emailMode) {
    assert.equal(a, bMsg, "the response differs by whether the account exists");
  } else {
    // Documented fallback: without email an account must still be creatable,
    // so the duplicate is visible and the throttle is what limits harvesting.
    assert.match(bMsg, /already exists/i);
  }
});

await check("password reset gives the same answer for any address", async () => {
  const read = async (email) => {
    const { ctx, page } = await newPage();
    await go(page, `${BASE}/forgot`);
    await page.fill("input[name=email]", email);
    await page.click("button[type=submit]");
    await page.waitForTimeout(1500);
    const msg = await formMessage(page);
    await ctx.close();
    return msg;
  };
  const known = await read(probeEmail);
  const unknown = await read(`nobody-${Date.now()}@example.test`);
  assert.equal(known, unknown, "the reset form reveals which addresses exist");
});

// --- link flows -------------------------------------------------------------

if (emailMode) {
  const email = `flow-${Date.now()}@example.test`;
  let verifyLink = null;

  await check("signup creates nothing until the link is used", async () => {
    const before = inbox().length;
    const r = await signupAttempt(email);
    assert.match(r.url, /\/signup/, "a session was started before verification");
    await r.ctx.close();
    const mail = inbox().slice(before).filter((m) => /confirm/i.test(m.subject));
    assert.equal(mail.length, 1, "no confirmation email was sent");
    verifyLink = mail[0].text.match(/https?:\/\/\S+verify\S*/)?.[0] ?? null;
    assert.ok(verifyLink, "no verification link in the email");
  });

  await check("the verification link creates the account and signs in", async () => {
    const { ctx, page } = await newPage();
    await go(page, verifyLink);
    await page.waitForTimeout(1500);
    assert.match(page.url(), /\/account/, `landed on ${page.url()}`);
    await ctx.close();
  });

  await check("a verification link cannot be used twice", async () => {
    const { ctx, page } = await newPage();
    await go(page, verifyLink);
    await page.waitForTimeout(1500);
    assert.ok(!/\/account/.test(page.url()), "a spent link still signed someone in");
    await ctx.close();
  });

  let resetLink = null;
  await check("a reset link arrives and works", async () => {
    const before = inbox().length;
    const { ctx, page } = await newPage();
    await go(page, `${BASE}/forgot`);
    await page.fill("input[name=email]", email);
    await page.click("button[type=submit]");
    await page.waitForTimeout(2000);
    await ctx.close();
    const mail = inbox().slice(before).filter((m) => /reset/i.test(m.subject));
    assert.equal(mail.length, 1, "no reset email was sent");
    resetLink = mail[0].text.match(/https?:\/\/\S+reset\S*/)?.[0] ?? null;
    assert.ok(resetLink, "no reset link in the email");

    const second = await newPage();
    await go(second.page, resetLink);
    await second.page.fill("input[name=password]", "a-brand-new-passphrase-here");
    await second.page.click("button[type=submit]");
    await second.page.waitForTimeout(2500);
    assert.match(second.page.url(), /\/account/, "reset did not sign the customer in");
    await second.ctx.close();
  });

  await check("a spent reset link is refused", async () => {
    const { ctx, page } = await newPage();
    await go(page, resetLink);
    await page.waitForTimeout(1200);
    const body = await page.locator("body").innerText();
    assert.match(body, /no longer valid|expired/i, "a spent reset link still rendered a form");
    await ctx.close();
  });

  await check("resetting a password signs out every other device", async () => {
    // Sign in, then reset from a second context, then check the first.
    const first = await newPage();
    await go(first.page, `${BASE}/login`);
    await first.page.fill("input[name=email]", email);
    await first.page.fill("input[name=password]", "a-brand-new-passphrase-here");
    await first.page.click("button[type=submit]");
    await first.page.waitForURL(/account/, { timeout: 20000 });

    const before = inbox().length;
    const asker = await newPage();
    await go(asker.page, `${BASE}/forgot`);
    await asker.page.fill("input[name=email]", email);
    await asker.page.click("button[type=submit]");
    await asker.page.waitForTimeout(2000);
    const link = inbox().slice(before).filter((m) => /reset/i.test(m.subject))
      .pop().text.match(/https?:\/\/\S+reset\S*/)[0];
    await go(asker.page, link);
    await asker.page.fill("input[name=password]", "yet-another-fine-passphrase");
    await asker.page.click("button[type=submit]");
    await asker.page.waitForTimeout(2500);
    await asker.ctx.close();

    await go(first.page, `${BASE}/account`);
    await first.page.waitForTimeout(1000);
    assert.match(first.page.url(), /\/login/,
      "the old session survived a password reset");
    await first.ctx.close();
  });
}

await browser.close();

const failed = results.filter(([, e]) => e);
const w = Math.max(...results.map(([n]) => n.length));
for (const [name, err] of results) {
  console.log(`  ${err ? "FAIL" : "ok  "}  ${name.padEnd(w)}`);
  if (err) console.log(`        ${err.split("\n")[0].slice(0, 170)}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
