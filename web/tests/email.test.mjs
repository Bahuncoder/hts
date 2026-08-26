/** Email wiring.
 *
 *  Email is the one output nobody sees until it reaches a stranger's inbox,
 *  so these run against a live server and check the parts that bite: the
 *  admin surfaces refusing unauthenticated callers, unsubscribe links that
 *  cannot be forged or reused across accounts, and the backlog rule — an
 *  alert we decline to email must still be stamped, or enabling a provider
 *  later floods the customer with history.
 *
 *  Start the server first:
 *    HTSDESK_ADMIN_TOKEN=... HTSDESK_EMAIL_SECRET=... npm run start
 *  Run: node tests/email.test.mjs
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import Database from "better-sqlite3";

const BASE = process.env.HTSDESK_TEST_WEB ?? "http://127.0.0.1:3000";
const TOKEN = process.env.HTSDESK_ADMIN_TOKEN ?? "admin-test-token";
const SECRET = process.env.HTSDESK_EMAIL_SECRET ?? "test-email-secret";

/** Seeds its own fixtures rather than relying on data left by another run.
 *  A test that depends on ambient state passes until someone tidies up. */
const DB = process.env.HTSDESK_ACCOUNTS_DB
  ?? path.join(process.cwd(), "..", "data", "accounts.db");
const PAID = `email-paid-${Date.now()}`;
const FREE = `email-free-${Date.now()}`;

function seed() {
  const d = new Database(DB);
  const now = new Date().toISOString();
  for (const [id, plan] of [[PAID, "growth"], [FREE, "free"]]) {
    d.prepare("INSERT OR IGNORE INTO account(id,email,password_hash,created_at) VALUES(?,?,?,?)")
      .run(id, `${id}@example.test`, "scrypt$0$0", now);
    d.prepare("INSERT OR IGNORE INTO subscription(account_id,plan,status,updated_at) VALUES(?,?,?,?)")
      .run(id, plan, "active", now);
    for (const [dg, h] of [["2804610000", "2804.61.00.00"], ["1301900000", "1301.90.00.00"]]) {
      d.prepare("INSERT OR IGNORE INTO watched_code VALUES(?,?,?,NULL,?)").run(id, dg, h, now);
    }
  }
  d.prepare("DELETE FROM diff_state").run();
  d.close();
}

function cleanup() {
  const d = new Database(DB);
  d.exec("PRAGMA foreign_keys=ON");
  for (const id of [PAID, FREE]) d.prepare("DELETE FROM account WHERE id=?").run(id);
  d.prepare("DELETE FROM diff_state").run();
  d.close();
}

seed();

const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push([name, null]); }
  catch (e) { results.push([name, e.message]); }
};

const get = async (path, headers = {}) => {
  const res = await fetch(`${BASE}${path}`, { headers });
  const body = await res.text();
  return { status: res.status, body };
};

const sign = (id) =>
  crypto.createHmac("sha256", SECRET).update(id).digest("base64url");

await check("diff runner refuses an unauthenticated caller", async () => {
  const res = await fetch(`${BASE}/api/admin/diff`, { method: "POST" });
  assert.equal(res.status, 401);
});

await check("diff runner refuses a wrong token", async () => {
  const res = await fetch(`${BASE}/api/admin/diff`, {
    method: "POST", headers: { "x-admin-token": "wrong-token-entirely" },
  });
  assert.equal(res.status, 401);
});

await check("the diff produces alerts for the seeded codes", async () => {
  const res = await fetch(`${BASE}/api/admin/diff?since=2026-08-01&send=0`, {
    method: "POST", headers: { "x-admin-token": TOKEN },
  });
  const d = await res.json();
  assert.ok(d.ran, "diff did not run");
  assert.ok(d.alertsCreated >= 2, `expected alerts, got ${d.alertsCreated}`);
});

await check("email preview refuses an unauthenticated caller", async () => {
  const { status } = await get(`/api/admin/email-preview?account=${PAID}`);
  assert.equal(status, 401);
});

await check("email preview renders a digest from real alerts", async () => {
  const { status, body } = await get(
    `/api/admin/email-preview?account=${PAID}`, { "x-admin-token": TOKEN });
  assert.equal(status, 200);
  const d = JSON.parse(body);
  assert.ok(d.subject.length > 0, "digest must have a subject");
  assert.match(d.text, /federalregister\.gov/, "must link the source document");
  assert.match(d.text, /not customs advice/i, "must carry the disclaimer");
  assert.match(d.text, /Stop these emails/, "must carry an unsubscribe link");
});

await check("digest groups one action per entry, not one per code", async () => {
  const { body } = await get(
    `/api/admin/email-preview?account=${PAID}`, { "x-admin-token": TOKEN });
  const d = JSON.parse(body);
  const titles = d.text.split("\n").filter((l) => l.startsWith("Silicon Metal"));
  assert.equal(new Set(titles).size, titles.length,
    "a title repeated per code reads as spam");
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
  assert.match(body, /did not work/,
    "one customer must not be able to unsubscribe another");
});

await check("no alert is left unstamped after a delivery run", async () => {
  await fetch(`${BASE}/api/admin/diff?since=2026-08-25`, {
    method: "POST", headers: { "x-admin-token": TOKEN },
  });
  const res = await fetch(`${BASE}/api/admin/diff?since=2026-08-25`, {
    method: "POST", headers: { "x-admin-token": TOKEN },
  });
  const d = await res.json();
  assert.equal(d.delivery.accountsConsidered, 0,
    "an unstamped alert is reconsidered forever and arrives as a backlog on upgrade");
});

cleanup();

const failed = results.filter(([, e]) => e);
const w = Math.max(...results.map(([n]) => n.length));
for (const [name, err] of results) {
  console.log(`  ${err ? "FAIL" : "ok  "}  ${name.padEnd(w)}`);
  if (err) console.log(`        ${err.split("\n")[0].slice(0, 150)}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
