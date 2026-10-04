/** Correcting a saved line's facts (HTS, origin, value, quantity) and
 *  recalculating its price against the engine — propose (spends the one
 *  engine call, stores a draft) then confirm (one atomic write, no second
 *  engine call). Mirrors reprice-review-races.test.mjs's shape: pure
 *  library functions against a scratch embedded libSQL file (never
 *  data/accounts.db) and a fake engine — no browser, no real server.
 *  Run: node tests/correction.test.mjs
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fakeServer, json, readBody, scratchDir, suite } from "./harness.mjs";
import { loadLib } from "./tsload.mjs";

process.env.HTSDESK_ACCOUNTS_DB = path.join(scratchDir("htsdesk-correction-"), "accounts.db");
delete process.env.TURSO_DATABASE_URL;

const ENGINE_PORT = 3498;
process.env.HTSDESK_API = `http://127.0.0.1:${ENGINE_PORT}`;

let engineCalls = 0;
// Always prices whatever facts are submitted as "ready", at 10% of the
// submitted value — a deterministic, unmissable stand-in for a real
// classification/pricing response.
const engine = await fakeServer(ENGINE_PORT, async (req, res) => {
  engineCalls += 1;
  const body = JSON.parse(await readBody(req));
  const lines = body.items.map((it, i) => ({
    row: it.row ?? i + 1, sku: it.sku, description: it.description, country: it.country,
    hts: it.hts, confidence: "given", status: "ready",
    review_reasons: [], warnings: [], incomplete: [], scope_unverified: [],
    entered_value: it.value, duty: Math.round(it.value * 0.10 * 100) / 100,
    effective_rate_pct: 10, refundable: 0,
    quantity: it.quantity, quantity_unit: it.quantity_unit,
  }));
  return json(res, 200, {
    summary: {
      submitted: lines.length, items: lines.length, processed: lines.length, priced: lines.length,
      unresolved: 0, by_status: {}, truncated: false, totals_complete: true,
      entered_value: 100, duty_and_hmf: 10, mpf: 7.77, duty: 10, effective_rate_pct: 10,
      potentially_refundable: 0, unclassified: 0, needs_scope_review: 0,
      assumptions: ["a fixture assumption"], dataset_revision: "rev-single-item",
    },
    lines,
  });
});

const { db, createAccount } = await loadLib("store");
const { setApproval, ensureReviews } = await loadLib("review");
const { proposeCorrection, confirmCorrection, getDraft } = await loadLib("correction");
const c = await db();
await ensureReviews();

let n = 0;
async function seedCatalogue({ approvalStatus = "pending", secondItemReady = true } = {}) {
  n += 1;
  const acc = `acc${n}`, cat = `cat${n}`, item = `item${n}`;
  await createAccount(acc, `${acc}@example.test`, "scrypt$x$y");
  await c.execute({
    sql: `INSERT INTO catalogue(id,account_id,name,created_at,updated_at,entries,by_vessel,mpf,dataset_revision,assumptions_json,totals_complete)
          VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    args: [cat, acc, "Fixture", new Date().toISOString(), new Date().toISOString(), 2, 0, 50, "rev-original", JSON.stringify(["original assumption"]), secondItemReady ? 0 : 1],
  });
  await c.execute({
    sql: `INSERT INTO catalogue_item(id,catalogue_id,sku,description,country,value,hts,digits,status,duty,effective_rate,refundable,scope_unverified,quantity,quantity_unit)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [item, cat, "A", "a cotton t-shirt", "China", 100, null, null, "unclassified", null, null, 0, 0, null, null],
  });
  if (secondItemReady) {
    await c.execute({
      sql: `INSERT INTO catalogue_item(id,catalogue_id,sku,description,country,value,hts,digits,status,duty,effective_rate,refundable,scope_unverified)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [`${item}b`, cat, "B", "an unrelated ready item", "China", 50, "9999.99.99.99", "9999999999", "ready", 5, 10, 0, 0],
    });
  }
  if (approvalStatus === "approved") {
    await c.execute({ sql: "UPDATE catalogue_item SET status = 'ready', hts = ?, digits = ?, duty = 5 WHERE id = ?", args: ["1111.11.11.11", "1111111111", item] });
    await setApproval(acc, "tester", item, "approved", "looks right", 0);
  }
  return { acc, cat, item };
}

const s = suite();

await s.check("propose then confirm: facts and price update, version bumps, a correction event is recorded", async () => {
  const { acc, cat, item } = await seedCatalogue();
  const propose = await proposeCorrection(acc, cat, item, { hts: "6109.10.00.12", country: "Vietnam", value: 200 }, 0);
  assert.equal(propose.ok, true, JSON.stringify(propose));

  const draft = await getDraft(acc, item, propose.draftId);
  assert.ok(draft, "the draft should be readable before confirming");
  assert.equal(draft.line.hts, "6109.10.00.12");
  assert.equal(draft.line.duty, 20, "10% of the overridden value (200), not the original (100)");

  const confirm = await confirmCorrection(acc, "reviewer@example.test", cat, item, propose.draftId, 0);
  assert.equal(confirm.ok, true, JSON.stringify(confirm));

  const row = (await c.execute({
    sql: "SELECT hts, country, value, duty, status, review_version, approval_status, evidence_json FROM catalogue_item WHERE id = ?",
    args: [item],
  })).rows[0];
  assert.equal(row.hts, "6109.10.00.12");
  assert.equal(row.country, "Vietnam");
  assert.equal(row.value, 200);
  assert.equal(row.duty, 20);
  assert.equal(row.status, "ready");
  assert.equal(row.review_version, 1, "version must bump");

  const events = (await c.execute({
    sql: "SELECT kind, comment FROM catalogue_item_event WHERE item_id = ? ORDER BY created_at", args: [item],
  })).rows;
  const correction = events.find((e) => e.kind === "correction");
  assert.ok(correction, "a correction history event must be recorded");
  assert.match(correction.comment, /HTS none → 6109\.10\.00\.12/);
  assert.match(correction.comment, /country China → Vietnam/);
  assert.match(correction.comment, /duty unpriced → \$20\.00/);

  // The draft is cleaned up once confirmed.
  assert.equal(await getDraft(acc, item, propose.draftId), null);
});

await s.check("a previously-approved line reopens to pending on correction, even with no net duty change stated as a fact", async () => {
  const { acc, cat, item } = await seedCatalogue({ approvalStatus: "approved" });
  // setApproval itself bumps review_version by 1 (commitReview's own
  // unconditional +1), so the seeded line starts at 1, not 0.
  const seeded = (await c.execute({ sql: "SELECT approval_status, review_version FROM catalogue_item WHERE id = ?", args: [item] })).rows[0];
  const propose = await proposeCorrection(acc, cat, item, { country: "Vietnam" }, seeded.review_version);
  assert.equal(propose.ok, true, JSON.stringify(propose));
  const confirm = await confirmCorrection(acc, "reviewer@example.test", cat, item, propose.draftId, seeded.review_version);
  assert.equal(confirm.ok, true, JSON.stringify(confirm));
  const row = (await c.execute({ sql: "SELECT approval_status, review_version FROM catalogue_item WHERE id = ?", args: [item] })).rows[0];
  assert.equal(row.approval_status, "pending", "correcting a fact must reopen an approved line");
  assert.ok(row.review_version > 0);
});

await s.check("a stale version at propose time fails before any engine call", async () => {
  const { acc, cat, item } = await seedCatalogue();
  const before = engineCalls;
  const propose = await proposeCorrection(acc, cat, item, { hts: "6109.10.00.12" }, 99);
  assert.equal(propose.ok, false);
  assert.equal(engineCalls, before, "no engine call should be spent on a version that was already stale");
});

await s.check("a stale version at confirm time (a write landed in between) fails without applying the draft", async () => {
  const { acc, cat, item } = await seedCatalogue();
  const propose = await proposeCorrection(acc, cat, item, { hts: "6109.10.00.12" }, 0);
  assert.equal(propose.ok, true);

  // Simulate a concurrent write (e.g. a reprice, or another correction)
  // landing between propose and confirm.
  await c.execute({ sql: "UPDATE catalogue_item SET review_version = review_version + 1 WHERE id = ?", args: [item] });

  const confirm = await confirmCorrection(acc, "reviewer@example.test", cat, item, propose.draftId, 0);
  assert.equal(confirm.ok, false);
  const row = (await c.execute({ sql: "SELECT hts FROM catalogue_item WHERE id = ?", args: [item] })).rows[0];
  assert.equal(row.hts, null, "the stale draft must not have been applied");
});

await s.check("a missing or expired draft at confirm time fails with a clear message, not a silent no-op", async () => {
  const { acc, cat, item } = await seedCatalogue();
  const missing = await confirmCorrection(acc, "reviewer@example.test", cat, item, "not-a-real-draft-id", 0);
  assert.equal(missing.ok, false);
  assert.match(missing.error, /could not be found/);

  const propose = await proposeCorrection(acc, cat, item, { hts: "6109.10.00.12" }, 0);
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  await c.execute({ sql: "UPDATE catalogue_item_correction SET created_at = ? WHERE id = ?", args: [old, propose.draftId] });
  const expired = await confirmCorrection(acc, "reviewer@example.test", cat, item, propose.draftId, 0);
  assert.equal(expired.ok, false);
  assert.match(expired.error, /expired/);
});

await s.check("catalogue.mpf/dataset_revision/assumptions are never touched by a single-item correction", async () => {
  const { acc, cat, item } = await seedCatalogue();
  const propose = await proposeCorrection(acc, cat, item, { hts: "6109.10.00.12" }, 0);
  await confirmCorrection(acc, "reviewer@example.test", cat, item, propose.draftId, 0);
  const row = (await c.execute({ sql: "SELECT mpf, dataset_revision, assumptions_json FROM catalogue WHERE id = ?", args: [cat] })).rows[0];
  assert.equal(row.mpf, 50, "the catalogue's real mpf must survive a one-item engine response's own (meaningless) mpf");
  assert.equal(row.dataset_revision, "rev-original");
  assert.equal(row.assumptions_json, JSON.stringify(["original assumption"]));
});

await s.check("catalogue.totals_complete flips to 1 when correcting the catalogue's last non-ready line", async () => {
  const { acc, cat, item } = await seedCatalogue({ secondItemReady: true });
  const before = (await c.execute({ sql: "SELECT totals_complete FROM catalogue WHERE id = ?", args: [cat] })).rows[0];
  assert.equal(before.totals_complete, 0, "one unclassified line among two means incomplete");

  const propose = await proposeCorrection(acc, cat, item, { hts: "6109.10.00.12" }, 0);
  await confirmCorrection(acc, "reviewer@example.test", cat, item, propose.draftId, 0);

  const after = (await c.execute({ sql: "SELECT totals_complete FROM catalogue WHERE id = ?", args: [cat] })).rows[0];
  assert.equal(after.totals_complete, 1, "both lines are now ready");
});

await s.check("the watched-code swap fires when a correction changes the HTS code", async () => {
  const { acc, cat, item } = await seedCatalogue();
  const propose = await proposeCorrection(acc, cat, item, { hts: "6109.10.00.12" }, 0);
  await confirmCorrection(acc, "reviewer@example.test", cat, item, propose.draftId, 0);
  const watched = (await c.execute({
    sql: "SELECT hts FROM watched_code WHERE account_id = ? AND catalogue_id = ?", args: [acc, cat],
  })).rows;
  assert.ok(watched.some((w) => w.hts === "6109.10.00.12"), "the newly-classified code must be watched");
});

await engine.close();
c.close();
process.exit(s.finish());
