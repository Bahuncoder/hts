/** An audit survives sign-up: the client-side draft, its privacy limits and the
 *  safe `?next=` return, driven in a real browser against the production build.
 *
 *  Production build on 3351, a fake engine on 3352 (tests/auditfixture.mjs), a
 *  scratch accounts database. No mail provider is configured, so sign-up
 *  creates the account at once and follows `next`.
 *
 *  Run: node tests/draft.test.mjs   (run with HTSDESK_ACCOUNTS_DB unset)
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { chromium } from "playwright-core";
import { fakeServer, json, readBody, seedAccount, startApp, suite } from "./harness.mjs";
import { auditResponse } from "./auditfixture.mjs";
import { loadLib } from "./tsload.mjs";

const KEY = "htsdesk.draft.v1";
const PASSWORD = "a-perfectly-fine-passphrase";
const CSV = "sku,description,country,value,hts\nD-1,cotton shirt,China,1000,\nD-2,ceramic mug,Germany,500,";

const engine = { audits: 0 };
const fake = await fakeServer(3352, async (req, res) => {
  if (req.url.startsWith("/api/audit")) {
    engine.audits += 1;
    return json(res, 200, auditResponse(JSON.parse(await readBody(req))));
  }
  return json(res, 404, { detail: "not found" });
});
const app = await startApp({
  port: 3351,
  env: { HTSDESK_API: "http://127.0.0.1:3352", HTSDESK_API_KEY: "k", HTSDESK_SIGNING_SECRET: "test-signing" },
});
const db = app.db();
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const { check, finish } = suite();

const contexts = [];
async function newPage({ token, storage = true, viewport = { width: 1280, height: 900 } } = {}) {
  const ctx = await browser.newContext({ viewport });
  contexts.push(ctx);
  if (!storage) {
    await ctx.addInitScript(() => {
      Object.defineProperty(window, "localStorage", {
        get() { throw new DOMException("The operation is insecure.", "SecurityError"); },
      });
    });
  }
  if (token) await ctx.addCookies([{ name: "htsdesk_session", value: token, url: app.base }]);
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(String(e)));
  return page;
}

async function seededSession(id) {
  await seedAccount(db, { id });
  const token = crypto.randomBytes(16).toString("hex");
  await db.execute({ sql: "INSERT INTO session(token, account_id, expires_at) VALUES(?,?,?)",
    args: [token, id, new Date(Date.now() + 3_600_000).toISOString()] });
  return token;
}

const stored = (p) => p.evaluate((k) => localStorage.getItem(k), KEY);
const setStored = (p, d) => p.evaluate(([k, v]) => localStorage.setItem(k, JSON.stringify(v)), [KEY, d]);
const validDraft = (over = {}) => ({ text: CSV, entries: 3, transport: "air", savedAt: Date.now() - 5 * 60_000, rows: 2, ...over });

async function runAudit(page, text = CSV) {
  await db.execute("DELETE FROM usage_event"); // budgets are tested in audit.test.mjs
  await page.fill("textarea", text);
  await page.getByRole("button", { name: "Run audit", exact: true }).click();
  await page.locator('[data-testid="reconciliation"]').waitFor({ timeout: 20000 });
}

/** Signs up through the UI (no mail provider: the account exists at once). */
async function signUpOn(page, email, next) {
  await page.goto(`${app.base}/signup${next ? `?next=${encodeURIComponent(next)}` : ""}`, { waitUntil: "networkidle" });
  await page.fill("input[name=email]", email);
  await page.fill("input[name=password]", PASSWORD);
  await page.click("button[type=submit]");
}
const uniq = (tag) => `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.test`;

try {
  // ---- pure helpers --------------------------------------------------------
  const next = await loadLib("next");
  const draftLib = await loadLib("draft");

  await check("safeNext: only the exact allowlist survives", () => {
    for (const ok of ["/audit", "/catalogues", "/account", "/alerts", "/hts/6109.10.00.12", "/hts/6109", "/hts/6109100012", "/hts/6109.10"]) {
      assert.equal(next.safeNext(ok), ok, ok);
    }
    for (const bad of ["https://evil.example", "//evil.example", "/api/x", "/api/audit", "/audit/", "/audit?x=1", "/audit#x",
      "/audit/../account", "/hts/", "/hts/abc", "/hts/6109.10.00.12/x", "/hts/../account", "/\\evil.example", "///audit",
      "javascript:alert(1)", "", " /audit", "/AUDIT", "/login", "/signup", "/logout", null, undefined, 42, {}]) {
      assert.equal(next.safeNext(bad), null, String(bad));
    }
    assert.equal(next.safeNext(["/alerts", "https://evil.example"]), "/alerts", "the first value of a repeated parameter");
    assert.equal(next.safeNext(["https://evil.example", "/alerts"]), null);
    assert.equal(next.nextQuery("/audit"), "?next=%2Faudit");
    assert.equal(next.nextQuery(null), "");
  });

  await check("parseDraft: expiry and shape are enforced on read", () => {
    const now = Date.now();
    const good = JSON.stringify(validDraft({ savedAt: now - 60_000 }));
    assert.equal(draftLib.parseDraft(good, now).rows, 2);
    assert.equal(draftLib.parseDraft(JSON.stringify(validDraft({ savedAt: now - 23 * 3600_000 })), now)?.rows, 2);
    assert.equal(draftLib.parseDraft(JSON.stringify(validDraft({ savedAt: now - 25 * 3600_000 })), now), null, "older than 24 hours");
    assert.equal(draftLib.parseDraft(JSON.stringify(validDraft({ savedAt: now + 3600_000 })), now), null, "from the future");
    for (const junk of ["", "not json", "null", "[]", '{"text":""}', JSON.stringify({ ...validDraft(), transport: "rail" }),
      JSON.stringify({ ...validDraft(), text: "   " }), JSON.stringify({ ...validDraft(), savedAt: "yesterday" })]) {
      assert.equal(draftLib.parseDraft(junk, now), null, junk);
    }
    assert.equal(draftLib.agoLabel(now - 30_000, now), "just now");
    assert.equal(draftLib.agoLabel(now - 5 * 60_000, now), "5 minutes ago");
    assert.equal(draftLib.agoLabel(now - 3 * 3600_000, now), "3 hours ago");
  });

  // ---- written when it should be ------------------------------------------
  await check("an anonymous run writes only text and the two settings, never results or proofs", async () => {
    const page = await newPage();
    await page.goto(`${app.base}/audit`, { waitUntil: "networkidle" });
    assert.equal(await stored(page), null, "nothing before any work");
    await page.locator("summary").filter({ hasText: /^Assumptions: / }).click();
    await page.fill('input[type="number"]', "3");
    await page.getByLabel("Transport", { exact: true }).selectOption("air");
    await runAudit(page);
    const raw = await stored(page);
    assert.ok(raw, "a draft was written after the successful run");
    const d = JSON.parse(raw);
    assert.deepEqual(Object.keys(d).sort(), ["entries", "rows", "savedAt", "text", "transport"]);
    assert.equal(d.text, CSV);
    assert.equal(d.entries, 3);
    assert.equal(d.transport, "air");
    assert.equal(d.rows, 2);
    assert.ok(Math.abs(Date.now() - d.savedAt) < 60_000);
    assert.doesNotMatch(raw, /proof|signed_at|duty|summary|lines|dataset_revision/i, "no engine output in the draft");
    // It is stated to the visitor, with a way to remove it.
    const body = await page.locator("main").innerText();
    assert.match(body, /kept in this browser for 24 hours/);
    await page.getByRole("button", { name: "Forget it now" }).click();
    assert.equal(await stored(page), null);
    assert.equal(await page.getByText(/kept in this browser for 24 hours/).count(), 0);
    assert.deepEqual(page.errors, []);
  });

  await check("the sample catalogue is never written, even when its sign-up link is clicked", async () => {
    const page = await newPage();
    await page.goto(`${app.base}/audit`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Try a sample" }).click();
    await db.execute("DELETE FROM usage_event");
    await page.getByRole("button", { name: "Run audit", exact: true }).click();
    await page.locator('[data-testid="reconciliation"]').waitFor({ timeout: 20000 });
    assert.equal(await stored(page), null, "not written after running the sample");
    await page.getByRole("link", { name: "Create a free account" }).click();
    await page.waitForURL(/\/signup/);
    assert.equal(await stored(page), null, "not written on the way to sign-up either");
  });

  await check("empty text is never written when a sign-up link is clicked", async () => {
    const page = await newPage();
    await page.goto(`${app.base}/audit`, { waitUntil: "networkidle" });
    await page.getByRole("link", { name: "Start free" }).click();
    await page.waitForURL(/\/signup/);
    assert.equal(await stored(page), null);
  });

  await check("clicking any sign-up or sign-in link on the audit page writes the draft first, and carries next=/audit", async () => {
    const page = await newPage();
    await page.goto(`${app.base}/audit`, { waitUntil: "networkidle" });
    await page.fill("textarea", CSV); // typed, not run
    await page.getByRole("link", { name: "Start free" }).click(); // the header link
    await page.waitForURL(/\/signup/);
    assert.equal(new URL(page.url()).searchParams.get("next"), "/audit");
    assert.equal(JSON.parse(await stored(page)).text, CSV);

    await page.goto(`${app.base}/audit`, { waitUntil: "networkidle" });
    await page.evaluate((k) => localStorage.removeItem(k), KEY);
    await runAudit(page);
    await page.evaluate((k) => localStorage.removeItem(k), KEY); // as if the run's own write had not happened
    await page.getByRole("link", { name: "sign in", exact: true }).click(); // the link in the results
    await page.waitForURL(/\/login/);
    assert.equal(new URL(page.url()).searchParams.get("next"), "/audit");
    assert.equal(JSON.parse(await stored(page)).rows, 2);

    // The header sign-in link also carries the destination.
    await page.goto(`${app.base}/audit`, { waitUntil: "networkidle" });
    await page.getByRole("link", { name: "Sign in", exact: true }).first().click();
    await page.waitForURL(/\/login/);
    assert.equal(new URL(page.url()).searchParams.get("next"), "/audit");
  });

  // ---- the whole point: anonymous -> sign up -> continue --------------------
  await check("anonymous audit, sign-up with next, then an explicit restore; nothing runs by itself", async () => {
    const page = await newPage();
    await page.goto(`${app.base}/audit`, { waitUntil: "networkidle" });
    await runAudit(page);
    await page.getByRole("link", { name: "Create a free account" }).click();
    await page.waitForURL(/\/signup\?next=/);
    assert.equal(await page.locator("input[name=next]").inputValue(), "/audit", "next is carried in the form");
    const audits = engine.audits;
    await page.fill("input[name=email]", uniq("flow"));
    await page.fill("input[name=password]", PASSWORD);
    await page.click("button[type=submit]");
    await page.waitForURL(/\/audit$/);

    const notice = page.getByTestId("draft-notice");
    await notice.waitFor();
    const t = await notice.innerText();
    assert.match(t, /You have an unsaved catalogue from earlier \(2 rows, saved (just now|\d+ minutes? ago)\)/);
    assert.match(t, /Kept only in this browser for 24 hours; cleared when you sign out/);
    assert.equal(await page.inputValue("textarea"), "", "not filled until asked");
    assert.equal(engine.audits, audits, "the audit did not run by itself");
    assert.ok(await stored(page), "the draft is kept until the visitor acts");

    await notice.getByRole("button", { name: "Restore it" }).click();
    assert.equal(await page.inputValue("textarea"), CSV);
    assert.equal(await notice.count(), 0, "the notice goes once restored");
    assert.equal(await stored(page), null, "restored: the draft is deleted");
    assert.equal(engine.audits, audits, "restoring does not run the audit either");
    assert.equal(await page.getByRole("button", { name: "Run audit", exact: true }).isEnabled(), true);
    assert.match(await page.locator("summary").filter({ hasText: /^Assumptions: / }).innerText(), /1 formal entry, vessel/);
    // And the visitor runs it, then saves it. The draft stays deleted.
    await page.getByRole("button", { name: "Run audit", exact: true }).click();
    await page.locator('[data-testid="reconciliation"]').waitFor({ timeout: 20000 });
    assert.equal(engine.audits, audits + 1);
    assert.equal(await stored(page), null, "a signed-in run writes no draft");
    await page.fill('input[placeholder*="Autumn"]', "After sign-up");
    await Promise.all([
      page.waitForURL(/\/catalogues\/[0-9a-f-]{36}/, { timeout: 30000 }),
      page.getByRole("button", { name: "Save and watch these codes" }).click(),
    ]);
    assert.deepEqual(page.errors, []);
  });

  await check("restoring puts back the two settings", async () => {
    const page = await newPage({ token: await seededSession("restorer") });
    await page.goto(`${app.base}/audit`, { waitUntil: "networkidle" });
    await setStored(page, validDraft({ entries: 4, transport: "air" }));
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Restore it" }).click();
    assert.match(await page.locator("summary").filter({ hasText: /^Assumptions: / }).innerText(), /4 formal entries, air shipment/);
  });

  await check("a save deletes a draft that was never restored", async () => {
    const page = await newPage({ token: await seededSession("saver") });
    await page.goto(`${app.base}/audit`, { waitUntil: "networkidle" });
    await setStored(page, validDraft());
    await page.reload({ waitUntil: "networkidle" });
    await runAudit(page, "sku,description,country,value\nS-1,shirt,China,10");
    await page.fill('input[placeholder*="Autumn"]', "Saver");
    await Promise.all([
      page.waitForURL(/\/catalogues\/[0-9a-f-]{36}/, { timeout: 30000 }),
      page.getByRole("button", { name: "Save and watch these codes" }).click(),
    ]);
    assert.equal(await stored(page), null);
  });

  await check("discard deletes the draft and leaves the form alone", async () => {
    const page = await newPage({ token: await seededSession("discarder") });
    await page.goto(`${app.base}/audit`, { waitUntil: "networkidle" });
    await setStored(page, validDraft());
    await page.reload({ waitUntil: "networkidle" });
    const notice = page.getByTestId("draft-notice");
    await notice.waitFor();
    await notice.getByRole("button", { name: "Discard" }).click();
    assert.equal(await notice.count(), 0);
    assert.equal(await stored(page), null);
    assert.equal(await page.inputValue("textarea"), "");
    await page.reload({ waitUntil: "networkidle" });
    assert.equal(await page.getByTestId("draft-notice").count(), 0, "still gone after a reload");
  });

  await check("a draft older than 24 hours is not offered, and is deleted", async () => {
    const page = await newPage({ token: await seededSession("expirer") });
    await page.goto(`${app.base}/audit`, { waitUntil: "networkidle" });
    await setStored(page, validDraft({ savedAt: Date.now() - 25 * 3600_000 }));
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForFunction((k) => localStorage.getItem(k) === null, KEY);
    assert.equal(await page.getByTestId("draft-notice").count(), 0);
    // The same on the account page.
    await setStored(page, validDraft({ savedAt: Date.now() - 25 * 3600_000 }));
    await page.goto(`${app.base}/account`, { waitUntil: "networkidle" });
    await page.waitForFunction((k) => localStorage.getItem(k) === null, KEY);
    assert.equal(await page.getByTestId("draft-notice").count(), 0);
    // A corrupt value is treated the same way.
    await page.evaluate((k) => localStorage.setItem(k, "{not json"), KEY);
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForFunction((k) => localStorage.getItem(k) === null, KEY);
  });

  await check("the draft is not offered to a visitor who is not signed in", async () => {
    const page = await newPage();
    await page.goto(`${app.base}/audit`, { waitUntil: "networkidle" });
    await setStored(page, validDraft());
    await page.reload({ waitUntil: "networkidle" });
    assert.equal(await page.getByRole("button", { name: "Restore it" }).count(), 0);
    assert.equal(await page.inputValue("textarea"), "");
  });

  await check("the account page shows the banner and leads back to the audit", async () => {
    const page = await newPage();
    await page.goto(`${app.base}/audit`, { waitUntil: "networkidle" });
    await setStored(page, validDraft());
    await signUpOn(page, uniq("banner")); // no next: lands on /account
    await page.waitForURL(/\/account$/);
    const notice = page.getByTestId("draft-notice");
    await notice.waitFor();
    assert.match(await notice.innerText(), /You have an unsaved catalogue from earlier \(2 rows, saved \d+ minutes? ago\)/);
    assert.equal(await notice.getByRole("link", { name: "Continue to audit" }).getAttribute("href"), "/audit");
    await notice.getByRole("link", { name: "Continue to audit" }).click();
    await page.waitForURL(/\/audit$/);
    await page.getByRole("button", { name: "Restore it" }).click();
    assert.equal(await page.inputValue("textarea"), CSV);
  });

  await check("signing out deletes the draft", async () => {
    const page = await newPage({ token: await seededSession("leaver") });
    await page.goto(`${app.base}/account`, { waitUntil: "networkidle" });
    await setStored(page, validDraft());
    await page.reload({ waitUntil: "networkidle" });
    await page.getByTestId("draft-notice").waitFor();
    await Promise.all([
      page.waitForURL((u) => !u.pathname.startsWith("/account")),
      page.getByRole("button", { name: "Sign out" }).click(),
    ]);
    assert.equal(await stored(page), null, "the next person on this computer finds nothing");
    await page.goto(`${app.base}/account`);
    await page.waitForURL(/\/login/);
  });

  // ---- storage that does not work -------------------------------------------
  await check("with storage disabled the audit works exactly the same, with no errors", async () => {
    const page = await newPage({ storage: false });
    await page.goto(`${app.base}/audit`, { waitUntil: "networkidle" });
    await runAudit(page);
    assert.equal(await page.getByText(/kept in this browser/).count(), 0, "no promise about a draft that was not kept");
    await page.getByRole("link", { name: "Create a free account" }).click();
    await page.waitForURL(/\/signup\?next=/);
    await signUpOn(page, uniq("nostorage"), "/audit");
    await page.waitForURL(/\/audit$/);
    assert.equal(await page.getByTestId("draft-notice").count(), 0);
    await runAudit(page); // signed in, still no storage
    await page.goto(`${app.base}/account`, { waitUntil: "networkidle" });
    assert.equal(await page.getByTestId("draft-notice").count(), 0);
    await Promise.all([
      page.waitForURL((u) => !u.pathname.startsWith("/account")),
      page.getByRole("button", { name: "Sign out" }).click(),
    ]);
    assert.deepEqual(page.errors, []);
  });

  await check("a full storage quota is survived the same way", async () => {
    const ctx = await browser.newContext();
    contexts.push(ctx);
    await ctx.addInitScript(() => {
      Storage.prototype.setItem = function () { throw new DOMException("quota", "QuotaExceededError"); };
    });
    const page = await ctx.newPage();
    page.errors = [];
    page.on("pageerror", (e) => page.errors.push(String(e)));
    await page.goto(`${app.base}/audit`, { waitUntil: "networkidle" });
    await runAudit(page);
    assert.equal(await stored(page), null);
    assert.equal(await page.getByText(/kept in this browser/).count(), 0);
    assert.deepEqual(page.errors, []);
  });

  // ---- ?next= ---------------------------------------------------------------
  const email = uniq("next");
  await check("sign-up honours an allowlisted next", async () => {
    const page = await newPage();
    await signUpOn(page, email, "/alerts");
    await page.waitForURL(/\/alerts$/);
  });

  await check("sign-in honours next=/audit, and an allowlisted code page", async () => {
    for (const [target, pattern] of [["/audit", /\/audit$/], ["/hts/6109.10.00.12", /\/hts\/6109\.10\.00\.12$/], ["/catalogues", /\/catalogues$/]]) {
      const page = await newPage();
      await page.goto(`${app.base}/login?next=${encodeURIComponent(target)}`, { waitUntil: "networkidle" });
      assert.equal(await page.locator("input[name=next]").inputValue(), target);
      assert.equal(await page.getByRole("link", { name: "Create one" }).getAttribute("href"), `/signup?next=${encodeURIComponent(target)}`);
      await page.fill("input[name=email]", email);
      await page.fill("input[name=password]", PASSWORD);
      await page.click("button[type=submit]");
      await page.waitForURL(pattern, { timeout: 20000 });
      assert.equal(new URL(page.url()).origin, app.base);
    }
  });

  await check("a next outside the allowlist is ignored: no open redirect", async () => {
    for (const evil of ["https://evil.example", "//evil.example", "/api/x", "/audit/../account", "/audit?x=1", "javascript:alert(1)", "/login"]) {
      const page = await newPage();
      await page.goto(`${app.base}/login?next=${encodeURIComponent(evil)}`, { waitUntil: "networkidle" });
      assert.equal(await page.locator("input[name=next]").count(), 0, `${evil}: not even placed in the form`);
      await page.fill("input[name=email]", email);
      await page.fill("input[name=password]", PASSWORD);
      await page.click("button[type=submit]");
      await page.waitForURL(/\/account$/, { timeout: 20000 });
      assert.equal(new URL(page.url()).origin, app.base, evil);
    }
  });

  await check("a next injected into the form itself is re-checked by the server action", async () => {
    for (const evil of ["https://evil.example/x", "//evil.example", "/api/admin/diff"]) {
      const page = await newPage();
      await page.goto(`${app.base}/login`, { waitUntil: "networkidle" });
      await page.evaluate((v) => {
        const i = document.createElement("input");
        i.type = "hidden"; i.name = "next"; i.value = v;
        document.querySelector("form").appendChild(i);
      }, evil);
      await page.fill("input[name=email]", email);
      await page.fill("input[name=password]", PASSWORD);
      await page.click("button[type=submit]");
      await page.waitForURL(/\/account$/, { timeout: 20000 });
      assert.equal(new URL(page.url()).origin, app.base, evil);
    }
  });

  await check("an already signed-in visitor on /login?next= is sent on, but only to an allowed place", async () => {
    const page = await newPage({ token: await seededSession("already") });
    await page.goto(`${app.base}/login?next=/alerts`);
    await page.waitForURL(/\/alerts$/);
    await page.goto(`${app.base}/login?next=${encodeURIComponent("https://evil.example")}`);
    await page.waitForURL(/\/account$/);
    await page.goto(`${app.base}/signup?next=/catalogues`);
    await page.waitForURL(/\/catalogues$/);
  });
} finally {
  for (const c of contexts) await c.close().catch(() => {});
  await browser.close().catch(() => {});
  db.close();
  await app.stop().catch(() => {});
  await fake.close();
}
process.exit(finish());
