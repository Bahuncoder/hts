/** Shared quota checks must not race (security audit 2026-10-06, S02).
 *
 *  Several callers that hold different leases (one per item) used to read the
 *  same remaining allowance and all proceed. The check and the charge are now
 *  one write transaction, so concurrent callers are serialised and exactly
 *  the allowed number succeed. Pure library calls against a scratch libSQL
 *  file (never data/accounts.db). Run: node tests/budget-race.test.mjs
 */
import assert from "node:assert/strict";
import path from "node:path";
import { scratchDir, suite } from "./harness.mjs";
import { loadLib } from "./tsload.mjs";

process.env.HTSDESK_ACCOUNTS_DB = path.join(scratchDir("htsdesk-budget-race-"), "accounts.db");
delete process.env.TURSO_DATABASE_URL;

const { db, createAccount } = await loadLib("store");
const { chargeAudit, chargeApi } = await loadLib("budget");

const t = suite();
const ONE_LEFT = { requests: { max: 10, windowMs: 3_600_000 }, items: { max: 10_000, windowMs: 3_600_000 } };

async function seedUsed(subject, requestsUsed) {
  const c = await db();
  const at = new Date().toISOString();
  for (let i = 0; i < requestsUsed; i += 1) {
    await c.execute({ sql: "INSERT INTO usage_event(scope, subject, at, cost) VALUES(?,?,?,?)", args: ["audit_requests", subject, at, 1] });
  }
}

async function requestCount(subject) {
  const c = await db();
  const r = await c.execute({ sql: "SELECT coalesce(sum(cost),0) n FROM usage_event WHERE scope = 'audit_requests' AND subject = ?", args: [subject] });
  return Number(r.rows[0].n);
}

await t.check("eight concurrent charges against one remaining request: exactly one succeeds", async () => {
  const subject = `race-${Date.now()}`;
  await seedUsed(subject, 9);
  const results = await Promise.all(Array.from({ length: 8 }, () => chargeAudit(subject, ONE_LEFT, 1)));
  const admitted = results.filter((r) => r.ok).length;
  assert.equal(admitted, 1, `admitted ${admitted}`);
  assert.equal(await requestCount(subject), 10, "usage must stop at the allowance");
});

await t.check("a refused charge records nothing", async () => {
  const subject = `refused-${Date.now()}`;
  await seedUsed(subject, 10);
  const r = await chargeAudit(subject, ONE_LEFT, 1);
  assert.equal(r.ok, false);
  assert.equal(await requestCount(subject), 10);
});

await t.check("refund removes exactly the rows of its own charge, not a neighbour's", async () => {
  const subject = `refund-${Date.now()}`;
  const first = await chargeAudit(subject, ONE_LEFT, 3);
  const second = await chargeAudit(subject, ONE_LEFT, 5);
  assert.ok(first.ok && second.ok);
  await second.refund();
  const c = await db();
  const items = await c.execute({ sql: "SELECT coalesce(sum(cost),0) n FROM usage_event WHERE scope = 'audit_items' AND subject = ?", args: [subject] });
  assert.equal(Number(items.rows[0].n), 3, "only the first charge's items should remain");
  assert.equal(await requestCount(subject), 1);
});

await t.check("the API scope keeps its own allowance, unaffected by the web UI's", async () => {
  const subject = `scopes-${Date.now()}`;
  await seedUsed(subject, 10);
  const r = await chargeApi(subject, ONE_LEFT, 1);
  assert.ok(r.ok, "the API allowance is separate from the web UI allowance");
});

await t.check("createAccount is still available for the rest of the suite", async () => {
  assert.equal(typeof createAccount, "function");
});

const code = t.finish();
process.exit(code);
