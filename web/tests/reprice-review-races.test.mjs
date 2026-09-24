/** Re-pricing's interaction with human review, under conditions an ordinary
 *  run never hits: the per-catalogue review-event cap already exceeded, and
 *  a review form left open (a stale review_version) across a reprice.
 *
 *  Found by an independent security review (2026-09-24) reading
 *  reprice.ts's first version: the approval reopen ran as a separate,
 *  best-effort call after the price update had already committed, with its
 *  boolean result ignored — so the event cap (or any other reason
 *  commitReview's WHERE clause might not match) left the screen reading
 *  "Approved" against a price that no longer existed, with nothing said.
 *  Separately, the price update never bumped review_version at all, so a
 *  stale review form (rendered before a reprice, submitted after) could
 *  approve figures it was never shown. Reproduced against the original code
 *  before fixing it — both checks below failed on that version.
 *
 *  Fix: the approval reopen (and the review_version bump, for every state,
 *  not only "approved") is now part of the SAME atomic statement that
 *  updates the price; only the cosmetic history-feed entry explaining the
 *  reopen is still best-effort, and its failure no longer affects whether
 *  the approval state itself is correct.
 *
 *  Pure library functions against a scratch embedded libSQL file (never
 *  data/accounts.db) and a fake engine — no browser, no real server.
 *  Run: node tests/reprice-review-races.test.mjs
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { fakeServer, json, readBody, scratchDir, suite } from "./harness.mjs";
import { loadLib } from "./tsload.mjs";

process.env.HTSDESK_ACCOUNTS_DB = path.join(scratchDir("htsdesk-reprice-races-"), "accounts.db");
delete process.env.TURSO_DATABASE_URL;

const ENGINE_PORT = 3497;
process.env.HTSDESK_API = `http://127.0.0.1:${ENGINE_PORT}`;

// Every re-price in this file prices the line at 30% instead of whatever it
// started at — a deliberate, unmissable "the rate moved" for every check.
const engine = await fakeServer(ENGINE_PORT, async (req, res) => {
  const body = JSON.parse(await readBody(req));
  const lines = body.items.map((it, i) => ({
    row: it.row ?? i + 1, sku: it.sku, description: it.description, country: it.country,
    hts: it.hts, confidence: "given", status: "ready",
    review_reasons: [], warnings: [], incomplete: [], scope_unverified: [],
    entered_value: it.value, duty: Math.round(it.value * 0.30 * 100) / 100,
    effective_rate_pct: 30, refundable: 0,
  }));
  return json(res, 200, {
    summary: {
      submitted: lines.length, items: lines.length, processed: lines.length, priced: lines.length,
      unresolved: 0, by_status: {}, truncated: false, totals_complete: true,
      entered_value: 100, duty_and_hmf: 30, mpf: 0, duty: 30, effective_rate_pct: 30,
      potentially_refundable: 0, unclassified: 0, needs_scope_review: 0,
      assumptions: [], dataset_revision: "rev-2",
    },
    lines,
  });
});

const { db, createAccount } = await loadLib("store");
const { setApproval, ensureReviews } = await loadLib("review");
const { repriceCatalogue } = await loadLib("reprice");
const c = await db();
await ensureReviews();

let n = 0;
async function seedCatalogue(approvalStatus) {
  n += 1;
  const acc = `acc${n}`, cat = `cat${n}`, item = `item${n}`;
  await createAccount(acc, `${acc}@example.test`, "scrypt$x$y");
  await c.execute({
    sql: "INSERT INTO catalogue(id,account_id,name,created_at,updated_at,entries,by_vessel) VALUES(?,?,?,?,?,?,?)",
    args: [cat, acc, "Fixture", new Date().toISOString(), new Date().toISOString(), 1, 1],
  });
  await c.execute({
    sql: `INSERT INTO catalogue_item(id,catalogue_id,sku,description,country,value,hts,digits,status,duty,effective_rate,refundable,scope_unverified)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [item, cat, "A", "d", "China", 100, "1234.56.78.90", "1234567890", "ready", 10, 10, 0, 0],
  });
  if (approvalStatus === "approved") {
    await setApproval(acc, "tester", item, "approved", "looks right", 0);
  }
  return { acc, cat, item };
}

const s = suite();

await s.check("an approved line is reopened to pending even with the per-catalogue review-event cap already exceeded", async () => {
  const { acc, cat, item } = await seedCatalogue("approved");
  const stmts = Array.from({ length: 1000 }, () => ({
    sql: `INSERT INTO catalogue_item_event(id,item_id,account_id,kind,actor,approval_status,assigned_to,comment,created_at,version)
          VALUES(?,?,?,?,?,?,?,?,?,?)`,
    args: [crypto.randomUUID(), item, acc, "comment", "seed", null, null, "filler", new Date().toISOString(), 1],
  }));
  await c.batch(stmts, "write");

  const outcome = await repriceCatalogue(acc, cat);
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(outcome.changed, 1);

  const row = (await c.execute({ sql: "SELECT approval_status, review_version, duty FROM catalogue_item WHERE id = ?", args: [item] })).rows[0];
  assert.equal(row.approval_status, "pending", "the approval must be reopened even though the event log could not record why");
  assert.equal(row.duty, 30, "the price itself still updated");
  assert.ok(row.review_version > 0, "review_version moved");
});

await s.check("a stale review form (open before a reprice) cannot approve the numbers it never saw", async () => {
  const { acc, cat, item } = await seedCatalogue("pending");
  // The version a browser would have rendered, before the reprice below runs.
  const staleVersion = (await c.execute({ sql: "SELECT review_version FROM catalogue_item WHERE id = ?", args: [item] })).rows[0].review_version;

  await repriceCatalogue(acc, cat);

  const staleApprove = await setApproval(acc, "reviewer", item, "approved", "looks fine", staleVersion);
  assert.equal(staleApprove, false, "an approval bound to the pre-reprice version must be refused");
  const row = (await c.execute({ sql: "SELECT approval_status FROM catalogue_item WHERE id = ?", args: [item] })).rows[0];
  assert.notEqual(row.approval_status, "approved", "the stale approval must not have taken effect");
});

await s.check("a line whose price did not materially change keeps its approval and version untouched", async () => {
  const { acc, cat, item } = await seedCatalogue("approved");
  const before = (await c.execute({ sql: "SELECT review_version FROM catalogue_item WHERE id = ?", args: [item] })).rows[0].review_version;
  // Overwrite the stored duty to already match what the fake engine always
  // returns (30% of 100 = 30), so this reprice is a genuine no-op price-wise.
  await c.execute({ sql: "UPDATE catalogue_item SET duty = 30, effective_rate = 30 WHERE id = ?", args: [item] });

  const outcome = await repriceCatalogue(acc, cat);
  assert.equal(outcome.changed, 0);
  const row = (await c.execute({ sql: "SELECT approval_status, review_version FROM catalogue_item WHERE id = ?", args: [item] })).rows[0];
  assert.equal(row.approval_status, "approved", "nothing changed, so nothing needed reopening");
  assert.equal(row.review_version, before, "no version churn when nothing actually moved");
});

await engine.close();
c.close();
process.exit(s.finish());
