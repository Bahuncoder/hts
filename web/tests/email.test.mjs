/** Email wiring.
 *
 *  Email is the one output nobody sees until it reaches a stranger's inbox,
 *  so these check the parts that bite: the admin surfaces refusing
 *  unauthenticated callers, unsubscribe links that cannot be forged or reused
 *  across accounts, and the backlog rule — an alert we decline to email must
 *  still be stamped, or enabling a provider later floods the customer with
 *  history.
 *
 *  Self-contained: starts the production build on 3204 with a scratch accounts
 *  database and a fake engine API on 3234 serving two tariff actions, and
 *  seeds its own accounts. It never touches data/accounts.db.
 *
 *  Run: node tests/email.test.mjs
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { ADMIN_TOKEN, EMAIL_SECRET, fakeEngine, seedAccount, startApp, suite } from "./harness.mjs";

const engine = await fakeEngine(3234);
const doc = (n, date, title) => ({
  document_number: n, title, publication_date: date,
  html_url: `https://www.federalregister.gov/d/${n}`,
  hts_mentions: ["2804.61", "1301.90"],
});
engine.state.docs = [
  doc("2026-15001", "2026-08-10", "Silicon Metal from China: Modification of Duties"),
  doc("2026-15002", "2026-08-26", "Silicon Metal: Notice of Inclusion Process"),
];
const app = await startApp({ port: 3204, env: { HTSDESK_API: "http://127.0.0.1:3234" } });

const PAID = "email-paid";
const FREE = "email-free";
const db = app.db();
for (const [id, plan] of [[PAID, "growth"], [FREE, "free"]]) {
  await seedAccount(db, { id, plan });
  for (const [dg, h] of [["2804610000", "2804.61.00.00"], ["1301900000", "1301.90.00.00"]]) {
    await db.execute({ sql: "INSERT INTO watched_code VALUES(?,?,?,NULL,?)",
      args: [id, dg, h, new Date().toISOString()] });
  }
}

const { check, finish } = suite();
const get = async (path, headers = {}) => {
  const res = await fetch(`${app.base}${path}`, { headers });
  return { status: res.status, body: await res.text() };
};
const sign = (id) => crypto.createHmac("sha256", EMAIL_SECRET).update(id).digest("base64url");
const admin = { "x-admin-token": ADMIN_TOKEN };

try {
  await check("diff runner refuses an unauthenticated caller", async () => {
    const res = await fetch(`${app.base}/api/admin/diff`, { method: "POST" });
    assert.equal(res.status, 401);
  });

  await check("diff runner refuses a wrong token", async () => {
    const res = await fetch(`${app.base}/api/admin/diff`, {
      method: "POST", headers: { "x-admin-token": "wrong-token-entirely" },
    });
    assert.equal(res.status, 401);
  });

  await check("the diff produces alerts for the seeded codes", async () => {
    const res = await app.admin("/api/admin/diff?since=2026-08-01&send=0");
    const d = await res.json();
    assert.ok(d.ran, "diff did not run");
    assert.ok(d.alertsCreated >= 2, `expected alerts, got ${d.alertsCreated}`);
  });

  await check("email preview refuses an unauthenticated caller", async () => {
    const { status } = await get(`/api/admin/email-preview?account=${PAID}`);
    assert.equal(status, 401);
  });

  await check("email preview renders a digest from real alerts", async () => {
    const { status, body } = await get(`/api/admin/email-preview?account=${PAID}`, admin);
    assert.equal(status, 200);
    const d = JSON.parse(body);
    assert.ok(d.subject.length > 0, "digest must have a subject");
    assert.match(d.text, /federalregister\.gov/, "must link the source document");
    assert.match(d.text, /not customs advice/i, "must carry the disclaimer");
    assert.match(d.text, /Stop these emails/, "must carry an unsubscribe link");
  });

  await check("digest groups one action per entry, not one per code", async () => {
    const { body } = await get(`/api/admin/email-preview?account=${PAID}`, admin);
    const d = JSON.parse(body);
    const titles = d.text.split("\n").filter((l) => l.startsWith("Silicon Metal"));
    assert.equal(titles.length, 2);
    assert.equal(new Set(titles).size, titles.length, "a title repeated per code reads as spam");
  });

  await check("a valid unsubscribe link works without a session", async () => {
    const { status, body } = await get(`/unsubscribe?a=${FREE}&t=${sign(FREE)}`);
    assert.equal(status, 200);
    assert.match(body, /Alert emails are off/);
  });

  await check("a forged unsubscribe token is refused", async () => {
    const { body } = await get(`/unsubscribe?a=${FREE}&t=not-a-real-token`);
    assert.match(body, /did not work/);
  });

  await check("an unsubscribe token cannot be reused for another account", async () => {
    const { body } = await get(`/unsubscribe?a=${PAID}&t=${sign(FREE)}`);
    assert.match(body, /did not work/, "one customer must not be able to unsubscribe another");
  });

  await check("no alert is left unstamped after a delivery run", async () => {
    await app.admin("/api/admin/diff?since=2026-08-25");
    const res = await app.admin("/api/admin/diff?since=2026-08-25");
    const d = await res.json();
    assert.equal(d.delivery.accountsConsidered, 0,
      "an unstamped alert is reconsidered forever and arrives as a backlog on upgrade");
    const rows = (await db.execute("SELECT DISTINCT account_id, email_status FROM alert")).rows;
    const status = Object.fromEntries(rows.map((r) => [r.account_id, r.email_status]));
    assert.equal(status[FREE], "skipped_plan");
    assert.equal(status[PAID], "skipped_no_provider");
  });
} finally {
  db.close();
  await app.stop();
  await engine.close();
}
process.exit(finish());
