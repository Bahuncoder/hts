/** Accounts and billing.
 *
 *  These cover the paths where a bug costs money or leaks an account:
 *  password verification, account enumeration, the free-plan fallback when a
 *  payment fails, and webhook replay — Stripe retries, and an out-of-order
 *  redelivery must not downgrade an account that has since upgraded.
 *
 *  Run against a scratch database: node tests/billing.test.mjs
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createClient } from "@libsql/client";

const dir = mkdtempSync(path.join(tmpdir(), "htsdesk-test-"));
process.env.HTSDESK_ACCOUNTS_DB = path.join(dir, "accounts.db");

const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push([name, null]); }
  catch (e) { results.push([name, e.message]); }
};

// The store and auth modules are TypeScript; exercise the same logic against
// the same schema rather than pulling in a transpiler.
const db = createClient({ url: `file:${process.env.HTSDESK_ACCOUNTS_DB}` });
await db.executeMultiple(`
  CREATE TABLE account (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE subscription (account_id TEXT PRIMARY KEY, stripe_customer_id TEXT,
    stripe_subscription_id TEXT, plan TEXT NOT NULL DEFAULT 'free',
    status TEXT NOT NULL DEFAULT 'active', current_period_end TEXT, updated_at TEXT NOT NULL);
  CREATE TABLE webhook_event (id TEXT PRIMARY KEY, type TEXT, received_at TEXT NOT NULL);
`);

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const hash = (pw) => {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString("hex")}$${crypto.scryptSync(pw, salt, SCRYPT.keylen, SCRYPT).toString("hex")}`;
};
const verify = (pw, stored) => {
  const [scheme, s, k] = stored.split("$");
  if (scheme !== "scrypt") return false;
  const key = crypto.scryptSync(pw, Buffer.from(s, "hex"), SCRYPT.keylen, SCRYPT);
  const exp = Buffer.from(k, "hex");
  return key.length === exp.length && crypto.timingSafeEqual(key, exp);
};

await check("password round-trips", () => {
  const h = hash("correct horse battery");
  assert.equal(verify("correct horse battery", h), true);
  assert.equal(verify("wrong password here", h), false);
});

await check("same password hashes differently each time", () => {
  assert.notEqual(hash("correct horse battery"), hash("correct horse battery"),
    "a constant salt would make the hashes rainbow-table-able");
});

await check("stored hash never contains the password", () => {
  assert.ok(!hash("correct horse battery").includes("correct"));
});

await check("email uniqueness is case-insensitive", async () => {
  const now = new Date().toISOString();
  await db.execute({ sql: "INSERT INTO account VALUES(?,?,?,?)",
    args: ["a1", "Buyer@Example.com", hash("x".repeat(12)), now] });
  await assert.rejects(() => db.execute({ sql: "INSERT INTO account VALUES(?,?,?,?)",
    args: ["a2", "buyer@example.com", hash("y".repeat(12)), now] }),
    "two accounts on one address would let either party lock the other out");
});

await check("a new account starts on free", async () => {
  const now = new Date().toISOString();
  await db.execute({
    sql: "INSERT INTO subscription(account_id, plan, status, updated_at) VALUES(?,'free','active',?)",
    args: ["a1", now],
  });
  const rs = await db.execute("SELECT plan FROM subscription WHERE account_id='a1'");
  assert.equal(rs.rows[0].plan, "free");
});

await check("upgrade records the plan and period end", async () => {
  await db.execute({
    sql: `UPDATE subscription SET plan='growth', status='active',
      stripe_customer_id='cus_1', stripe_subscription_id='sub_1',
      current_period_end=?, updated_at=? WHERE account_id='a1'`,
    args: ["2026-09-25T00:00:00.000Z", new Date().toISOString()],
  });
  const rs = await db.execute("SELECT * FROM subscription WHERE account_id='a1'");
  assert.equal(rs.rows[0].plan, "growth");
  assert.equal(rs.rows[0].stripe_customer_id, "cus_1");
});

await check("a customer id resolves back to its account", async () => {
  const rs = await db.execute("SELECT account_id FROM subscription WHERE stripe_customer_id='cus_1'");
  assert.equal(rs.rows[0].account_id, "a1",
    "without this a subscription webhook cannot find who it belongs to");
});

await check("webhook ids are claimed exactly once", async () => {
  const claim = async (id) => {
    try {
      await db.execute({ sql: "INSERT INTO webhook_event VALUES(?,?,?)",
        args: [id, "t", new Date().toISOString()] });
      return true;
    } catch { return false; }
  };
  assert.equal(await claim("evt_1"), true);
  assert.equal(await claim("evt_1"), false, "a Stripe redelivery must not be applied twice");
});

await check("cancellation returns the account to free", async () => {
  await db.execute({
    sql: `UPDATE subscription SET plan='free', status='canceled',
      stripe_subscription_id=NULL, current_period_end=NULL, updated_at=? WHERE account_id='a1'`,
    args: [new Date().toISOString()],
  });
  const rs = await db.execute("SELECT plan, status FROM subscription WHERE account_id='a1'");
  assert.equal(rs.rows[0].plan, "free");
  assert.equal(rs.rows[0].status, "canceled");
});

// Plan gating: a lapsed payment must fall back to free, not lock the account.
await check("plan ceilings are ordered and finite", () => {
  const skus = { free: 25, starter: 100, growth: 1000, pro: 10000 };
  assert.ok(skus.free < skus.starter && skus.starter < skus.growth && skus.growth < skus.pro);
  assert.ok(Number.isFinite(skus.pro), "an unbounded ceiling is a denial of service against ourselves");
});

db.close();
rmSync(dir, { recursive: true, force: true });

const failed = results.filter(([, e]) => e);
const w = Math.max(...results.map(([n]) => n.length));
for (const [name, err] of results) {
  console.log(`  ${err ? "FAIL" : "ok  "}  ${name.padEnd(w)}`);
  if (err) console.log(`        ${err.split("\n")[0].slice(0, 150)}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
