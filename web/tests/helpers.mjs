/** Shared browser-test helpers.
 *
 *  Signing up is not one flow any more: with a mail provider configured an
 *  account is only created when the confirmation link is used, which is what
 *  closes the enumeration oracle. Tests should exercise whichever flow the
 *  server is actually running, not assume one.
 */
import fs from "node:fs";

export const BASE = process.env.HTSDESK_TEST_WEB ?? "http://localhost:3000";
export const MAILBOX = process.env.HTSDESK_MAILBOX ?? "/tmp/mailbox.jsonl";
export const PASSWORD = "a-perfectly-fine-passphrase";

/** Fonts are fetched from Google on every fresh context; they change nothing
 *  about behaviour and make navigation waits flaky. */
export async function newContext(browser, opts = {}) {
  const ctx = await browser.newContext(opts);
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  return ctx;
}

export const go = (page, url) => page.goto(url, { waitUntil: "domcontentloaded" });

export function inbox() {
  try {
    return fs.readFileSync(MAILBOX, "utf8").trim().split("\n")
      .filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

/** Creates a signed-in account, following the verification link when the
 *  server requires one. Returns the context, page and email. */
export async function signUp(browser, tag, opts = {}) {
  const ctx = await newContext(browser, opts);
  const page = await ctx.newPage();
  const email = `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.test`;

  const before = inbox().length;
  await go(page, `${BASE}/signup`);
  await page.fill("input[name=email]", email);
  await page.fill("input[name=password]", PASSWORD);
  await page.click("button[type=submit]");

  // Fast path: no provider configured, the account exists immediately.
  try {
    await page.waitForURL(/\/account/, { timeout: 6000 });
    return { ctx, page, email };
  } catch { /* verification required */ }

  const mail = inbox().slice(before)
    .filter((m) => /confirm/i.test(m.subject) && m.to?.includes?.(email) !== false);
  const link = mail.map((m) => m.text.match(/https?:\/\/\S+verify\S*/)?.[0])
    .filter(Boolean).pop();
  if (!link) {
    throw new Error(`signup needed verification but no link reached ${MAILBOX}`);
  }
  // /verify is deliberately GET-then-POST, not a one-step redirect: the GET
  // only ever shows a confirm button (so a link preview, image fetch or
  // cross-site navigation can't silently consume the token by visiting it),
  // and the POST it submits verifies and lands on /login — never /account,
  // never auto-signed-in. Confirming, then signing in, is the real flow.
  await go(page, link);
  await page.click("button[type=submit]");
  await page.waitForURL(/\/login/, { timeout: 20000 });
  await page.fill("input[name=email]", email);
  await page.fill("input[name=password]", PASSWORD);
  await page.click("button[type=submit]");
  await page.waitForURL(/\/account/, { timeout: 20000 });
  return { ctx, page, email };
}
