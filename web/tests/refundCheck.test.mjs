/** Entry Refund Check (app/api/refund-check, app/api/refund-checks/evidence):
 *  plan gating, the struck-down-IEEPA figure attributed against a real
 *  stated duty_paid, PSC/protest/liquidation timing, metering independent
 *  of ordinary audit usage, and evidence export.
 *
 *  Production build on 3207 with a scratch database and a bespoke fake
 *  engine on 3237 (not harness.mjs's fakeEngine, which returns a stub
 *  {ok, submitted} shape -- this suite needs a controllable per-line
 *  `refundable`/`duty`/`hts` in the real {summary, lines} shape).
 *
 *  Run: node tests/refundCheck.test.mjs
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { fakeServer, json, seedAccount, startApp, suite } from "./harness.mjs";

const DAY = 86_400_000;
const isoDaysAgo = (n) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);

const engineState = { refundable: 0, duty: 100, status: "ready", fail: false };

const engine = await fakeServer(3237, async (req, res) => {
  if (req.method !== "POST" || !req.url.startsWith("/api/audit")) return json(res, 404, { detail: "not found" });
  if (engineState.fail) return json(res, 500, { detail: "forced failure" });
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const lines = body.items.map((it) => ({
    row: it.row, sku: it.sku ?? "", description: it.description, country: it.country,
    hts: it.hts ?? "9999.99.99.99", confidence: it.hts ? null : "high", status: engineState.status,
    duty: engineState.duty, effective_rate_pct: 10, refundable: engineState.refundable,
    scope_unverified: [], error: null, review_reasons: [], warnings: [], incomplete: [],
  }));
  return json(res, 200, {
    summary: { submitted: lines.length, items: lines.length, processed: lines.length, priced: lines.length,
      unresolved: 0, totals_complete: true, entered_value: 0, duty: 0, dataset_revision: "test" },
    lines,
  });
});

const app = await startApp({
  port: 3207,
  env: { HTSDESK_API: "http://127.0.0.1:3237", HTSDESK_API_KEY: "engine-key" },
});
const db = app.db();

let seq = 0;
async function accountWithSession(plan = "growth") {
  const id = `acct-${++seq}`;
  await seedAccount(db, { id, plan });
  const token = crypto.randomBytes(16).toString("hex");
  await db.execute({
    sql: "INSERT INTO session(token, account_id, expires_at) VALUES(?,?,?)",
    args: [token, id, new Date(Date.now() + 3_600_000).toISOString()],
  });
  return { id, cookie: `htsdesk_session=${token}` };
}

const row = (overrides = {}) => ({
  description: "cotton t-shirt", country: "China", value: 1000,
  entryDate: isoDaysAgo(30), dutyPaid: 150, entryHts: "6109.10.00.12", liquidationDate: null,
  ...overrides,
});

async function post(cookie, body) {
  const res = await fetch(`${app.base}/api/refund-check`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
  const parsed = await res.json().catch(() => null);
  return { status: res.status, headers: res.headers, body: parsed };
}

const used = async (subject, scope) => (await db.execute({
  sql: "SELECT coalesce(sum(cost),0) AS n FROM usage_event WHERE subject = ? AND scope = ?",
  args: [subject, scope],
})).rows[0].n;

const { check, finish } = suite();

try {
  await check("a signed-out caller is refused", async () => {
    const r = await post(null, { name: "x", items: [row()] });
    assert.equal(r.status, 401);
  });

  await check("a free-plan account is refused, with an upsell to /pricing", async () => {
    const a = await accountWithSession("free");
    const r = await post(a.cookie, { name: "x", items: [row()] });
    assert.equal(r.status, 403);
    assert.match(r.body.detail, /not included on your plan/);
  });

  await check("malformed and empty submissions are 400s and never reach the engine", async () => {
    const a = await accountWithSession("starter");
    assert.equal((await post(a.cookie, { name: "x", items: [] })).status, 400);
    assert.equal((await post(a.cookie, { name: "x" })).status, 400);
    const res = await fetch(`${app.base}/api/refund-check`, {
      method: "POST", headers: { "content-type": "application/json", cookie: a.cookie }, body: "not json",
    });
    assert.equal(res.status, 400);
  });

  await check("a row missing entry date or duty paid is rejected, named, and excluded -- not silently dropped", async () => {
    const a = await accountWithSession("starter");
    const r = await post(a.cookie, {
      name: "x", items: [row(), { description: "no dates", country: "China", value: 100, dutyPaid: 50 }],
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.items.length, 1, "only the valid row was processed");
    assert.equal(r.body.rejected.length, 1);
    assert.equal(r.body.rejected[0].row, 2);
    assert.match(r.body.rejected[0].reason, /entry date/);
  });

  await check("the struck-down-refundable figure is attributed against the stated duty paid", async () => {
    engineState.refundable = 227.5;
    const a = await accountWithSession("starter");
    const r = await post(a.cookie, { name: "IEEPA check", items: [row({ dutyPaid: 227.5 })] });
    assert.equal(r.status, 200);
    assert.equal(r.body.items[0].struckDownRefundable, 227.5);
    assert.equal(r.body.items[0].dutyPaid, 227.5);
    const saved = (await db.execute({
      sql: "SELECT struck_down_refundable, duty_paid FROM refund_check_item WHERE refund_check_id = ?",
      args: [r.body.id],
    })).rows[0];
    assert.equal(saved.struck_down_refundable, 227.5);
    assert.equal(saved.duty_paid, 227.5);
    engineState.refundable = 0;
  });

  await check("under 300 days, no liquidation date: PSC may be available, protest cannot be determined", async () => {
    const a = await accountWithSession("starter");
    const r = await post(a.cookie, { name: "x", items: [row({ entryDate: isoDaysAgo(50) })] });
    assert.equal(r.body.items[0].pscEligible, "may be available");
    assert.equal(r.body.items[0].protestDeadline, "cannot be determined without a liquidation date");
  });

  await check("300-365 days, no liquidation date: PSC likely closed, protest still cannot be determined", async () => {
    const a = await accountWithSession("starter");
    const r = await post(a.cookie, { name: "x", items: [row({ entryDate: isoDaysAgo(340) })] });
    assert.equal(r.body.items[0].pscEligible, "likely closed");
    assert.equal(r.body.items[0].protestDeadline, "cannot be determined without a liquidation date");
  });

  await check("over 365 days, no liquidation date: deemed-liquidation framing, never asserted as fact", async () => {
    const a = await accountWithSession("starter");
    const r = await post(a.cookie, { name: "x", items: [row({ entryDate: isoDaysAgo(400) })] });
    assert.equal(r.body.items[0].pscEligible, "likely closed");
    assert.equal(r.body.items[0].protestDeadline, "cannot be determined without a liquidation date");
    assert.match(r.body.items[0].protestDetail, /would have deemed-liquidated/);
    assert.doesNotMatch(r.body.items[0].protestDetail, /has liquidated\.|is liquidated\./, "never a flat assertion");
  });

  await check("a liquidation date inside the 180-day protest window is flagged open, with a real deadline", async () => {
    const a = await accountWithSession("starter");
    const r = await post(a.cookie, {
      name: "x", items: [row({ entryDate: isoDaysAgo(400), liquidationDate: isoDaysAgo(100) })],
    });
    assert.equal(r.body.items[0].pscEligible, "not available -- this entry has already liquidated");
    assert.notEqual(r.body.items[0].protestDeadline, "cannot be determined without a liquidation date");
    assert.match(r.body.items[0].protestDetail, /is open/);
  });

  await check("a liquidation date outside the 180-day protest window is flagged closed", async () => {
    const a = await accountWithSession("starter");
    const r = await post(a.cookie, {
      name: "x", items: [row({ entryDate: isoDaysAgo(400), liquidationDate: isoDaysAgo(200) })],
    });
    assert.match(r.body.items[0].protestDetail, /closed on/);
    assert.match(r.body.items[0].protestDetail, /jurisdictional/);
  });

  await check("protest_deadline is a real date only when a real liquidation date is given", async () => {
    const a = await accountWithSession("starter");
    const withLiq = await post(a.cookie, {
      name: "x", items: [row({ entryDate: isoDaysAgo(400), liquidationDate: isoDaysAgo(100) })],
    });
    assert.match(withLiq.body.items[0].protestDeadline, /^\d{4}-\d{2}-\d{2}$/);
    const without = await post(a.cookie, { name: "x", items: [row({ entryDate: isoDaysAgo(400) })] });
    assert.equal(without.body.items[0].protestDeadline, "cannot be determined without a liquidation date");
  });

  await check("the per-request ceiling matches the plan's productsPerAudit", async () => {
    const a = await accountWithSession("starter"); // productsPerAudit === 500
    const items = Array.from({ length: 501 }, () => row());
    const over = await post(a.cookie, { name: "x", items });
    assert.equal(over.status, 413);
    assert.match(over.body.detail, /501 entries exceeds the 500 allowed/);
  });

  await check("refund-check usage is metered independently of ordinary audit usage", async () => {
    const a = await accountWithSession("starter");
    const subject = `account:${a.id}`;
    await db.execute({
      sql: "INSERT INTO usage_event(scope, subject, at, cost) VALUES(?,?,?,?)",
      args: ["audit_items", subject, new Date().toISOString(), 4_999],
    });
    const r = await post(a.cookie, { name: "x", items: [row()] });
    assert.equal(r.status, 200);
    assert.equal(await used(subject, "refund_check_items"), 1);
    assert.equal(await used(subject, "audit_items"), 4_999, "must not share the web-UI audit scope");
  });

  await check("daily refund-check item allowance is enforced, with Retry-After", async () => {
    const a = await accountWithSession("starter"); // refundCheck.itemsPerDay.max === 200
    const subject = `account:${a.id}`;
    await db.execute({
      sql: "INSERT INTO usage_event(scope, subject, at, cost) VALUES(?,?,?,?)",
      args: ["refund_check_items", subject, new Date().toISOString(), 199],
    });
    const items = Array.from({ length: 5 }, () => row());
    const over = await post(a.cookie, { name: "x", items });
    assert.equal(over.status, 429);
    assert.ok(Number(over.headers.get("retry-after")) > 0);
    assert.equal((await post(a.cookie, { name: "x", items: [row()] })).status, 200);
  });

  await check("the saved-check cap is enforced per plan", async () => {
    // Seeded directly (matching audit.test.mjs's preload() pattern): 10 real
    // POSTs would also trip starter's own 10-requests/hour rate limit before
    // ever reaching the maxChecks=10 cap this test targets.
    const a = await accountWithSession("starter"); // maxChecks === 10
    const now = new Date().toISOString();
    for (let i = 0; i < 10; i++) {
      await db.execute({
        sql: "INSERT INTO refund_check(id, account_id, name, created_at, updated_at) VALUES(?,?,?,?,?)",
        args: [crypto.randomUUID(), a.id, `seeded ${i}`, now, now],
      });
    }
    const over = await post(a.cookie, { name: "one too many", items: [row()] });
    assert.equal(over.status, 413);
    assert.match(over.body.detail, /10 saved refund checks/);
  });

  await check("an engine failure is not billed and never leaks raw engine text", async () => {
    const a = await accountWithSession("starter");
    const subject = `account:${a.id}`;
    const before = await used(subject, "refund_check_items");
    engineState.fail = true;
    const r = await post(a.cookie, { name: "x", items: [row()] });
    assert.equal(r.status, 502);
    assert.doesNotMatch(JSON.stringify(r.body), /forced failure/);
    assert.equal(await used(subject, "refund_check_items"), before);
    engineState.fail = false;
  });

  await check("evidence export produces a downloadable JSON body carrying every field", async () => {
    engineState.refundable = 42;
    const a = await accountWithSession("starter");
    const created = await post(a.cookie, {
      name: "Export me", items: [row({ dutyPaid: 42, liquidationDate: isoDaysAgo(50) })],
    });
    assert.equal(created.status, 200);
    const res = await fetch(`${app.base}/api/refund-checks/evidence?id=${created.body.id}`, {
      headers: { cookie: a.cookie },
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-disposition") ?? "", /attachment/);
    const body = await res.json();
    assert.equal(body.refund_check.name, "Export me");
    const item = body.items[0];
    assert.equal(item.struck_down_refundable, 42);
    assert.equal(item.duty_paid, 42);
    assert.ok(item.protest_deadline);
    assert.ok(Array.isArray(body.limitations) && body.limitations.length > 0);
    engineState.refundable = 0;
  });

  await check("evidence export refuses another account's refund check", async () => {
    const a = await accountWithSession("starter");
    const b = await accountWithSession("starter");
    const created = await post(a.cookie, { name: "mine", items: [row()] });
    const res = await fetch(`${app.base}/api/refund-checks/evidence?id=${created.body.id}`, {
      headers: { cookie: b.cookie },
    });
    assert.equal(res.status, 404);
  });
} finally {
  db.close();
  await app.stop();
  await engine.close();
}
process.exit(finish());
