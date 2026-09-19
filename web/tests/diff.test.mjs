/** Change diffing against a fake engine API, through the real admin route.
 *
 *  The fake follows the documented /api/changes contract (inclusive `since`,
 *  `cursor` continuing strictly after a "date|document" position, `has_more`,
 *  `next_cursor`). Production build on 3201, engine on 3231, scratch database.
 *
 *  Run: node tests/diff.test.mjs
 */
import assert from "node:assert/strict";
import { fakeEngine, seedAccount, startApp, suite } from "./harness.mjs";

const engine = await fakeEngine(3231);
const app = await startApp({
  port: 3201,
  env: { HTSDESK_API: "http://127.0.0.1:3231", HTSDESK_API_KEY: "engine-key" },
});
const db = app.db();
await seedAccount(db, { id: "watcher" });
await db.execute({
  sql: "INSERT INTO watched_code(account_id,digits,hts,catalogue_id,created_at) VALUES(?,?,?,NULL,?)",
  args: ["watcher", "2804610000", "2804.61.00.00", new Date().toISOString()],
});

const doc = (n, date, mentions = ["2804.61"]) => ({
  document_number: n, title: `Action ${n}`, publication_date: date,
  html_url: `https://www.federalregister.gov/d/${n}`, hts_mentions: mentions,
});
const run = async (query = "") => {
  const res = await app.admin(`/api/admin/diff?send=0${query}`);
  assert.equal(res.status, 200);
  return res.json();
};
const state = async () => (await db.execute("SELECT * FROM diff_state WHERE id = 1")).rows[0];
const alertCount = async () =>
  (await db.execute("SELECT count(*) AS n FROM alert")).rows[0].n;

const { check, finish } = suite();

try {
  await check("a first run with no stored position starts recently, not at the beginning of time", async () => {
    // A new install, or one whose cursor was lost, must not alert every
    // watcher about all of history (and email them a digest of it).
    const recent = new Date(Date.now() - 5 * 864e5).toISOString().slice(0, 10);
    engine.state.docs = [doc("old1", "2025-01-01"), doc("new1", recent)];
    const r = await run();
    const ageDays = (Date.now() - Date.parse(engine.state.changesCalls[0].since)) / 864e5;
    assert.ok(ageDays > 25 && ageDays < 35, `first run asked for ${ageDays.toFixed(0)} days of history`);
    assert.equal(r.documentsConsidered, 1);
    assert.equal(r.alertsCreated, 1, "only the recent action may alert");
    await db.execute("DELETE FROM alert");
    await db.execute("DELETE FROM diff_state");
    engine.state.changesCalls.length = 0;
    engine.state.changesKeys.length = 0;
  });

  await check("an explicit since still backfills further back", async () => {
    engine.state.docs = [doc("old2", "2025-01-01")];
    const r = await run("&since=2024-12-01");
    assert.equal(r.alertsCreated, 1);
    await db.execute("DELETE FROM alert");
    await db.execute("DELETE FROM diff_state");
    engine.state.changesCalls.length = 0;
    engine.state.changesKeys.length = 0;
  });

  await check("a date spread over several pages is read in full", async () => {
    engine.state.docs = ["d1", "d2", "d3", "d4", "d5"].map((n) => doc(n, "2026-08-10"));
    const r = await run("&limit=2&since=2026-08-01");
    assert.equal(r.ran, true);
    assert.equal(r.documentsConsidered, 5);
    assert.equal(r.alertsCreated, 5, "every document on the date, not just the first page");
    const s = await state();
    assert.equal(s.cursor, "2026-08-10|d5");
    assert.equal(s.last_seen_date, "2026-08-10");
    const pages = engine.state.changesCalls;
    assert.equal(pages.length, 3, "pages of 2, 2 and 1");
  });

  await check("the request carries the engine key and follows next_cursor", async () => {
    const calls = engine.state.changesCalls;
    assert.ok(calls[0].since, "first page starts from a date");
    assert.ok(!calls[0].cursor);
    assert.ok(calls.slice(1).every((c) => c.cursor && !c.since), "later pages continue by cursor");
    assert.ok(calls.every((c) => c.limit === "2"), "limit is the page size");
    assert.ok(engine.state.changesKeys.every((k) => k === "engine-key"));
  });

  await check("a re-run replays a lookback window without duplicating alerts", async () => {
    engine.state.changesCalls.length = 0;
    const r = await run("&limit=2");
    assert.equal(r.alertsCreated, 0);
    assert.ok(r.documentsConsidered >= 5, "the window behind the cursor is re-read");
    assert.equal(engine.state.changesCalls[0].since, "2026-08-03", "cursor date minus 7 days");
    assert.equal(await alertCount(), 5);
  });

  await check("a late-arriving, older-dated document is picked up", async () => {
    engine.state.docs.push(doc("late1", "2026-08-06"));
    const r = await run("&limit=2");
    assert.equal(r.alertsCreated, 1);
    assert.equal(await alertCount(), 6);
    assert.equal((await state()).cursor, "2026-08-10|d5", "an older document does not move the cursor back");
  });

  await check("an HTTP 500 is a failed run and leaves the cursor alone", async () => {
    const before = await state();
    const alerts = await alertCount();
    engine.state.docs.push(doc("n1", "2026-08-12"), doc("n2", "2026-08-12"));
    engine.state.changesCalls.length = 0;
    engine.state.failChangesAt = 1;
    const r = await run("&limit=2");
    assert.equal(r.ran, false);
    assert.match(r.reason, /500/);
    assert.equal((await state()).cursor, before.cursor);
    assert.equal((await state()).last_run_at, before.last_run_at, "a failed run is not recorded as a run");
    assert.equal(await alertCount(), alerts);
  });

  await check("a failure part-way through the pages writes nothing", async () => {
    const before = await state();
    const alerts = await alertCount();
    engine.state.changesCalls.length = 0;
    engine.state.failChangesAt = 3;
    const r = await run("&limit=2");
    assert.equal(r.ran, false);
    assert.equal(engine.state.changesCalls.length, 3);
    assert.equal((await state()).cursor, before.cursor);
    assert.equal(await alertCount(), alerts, "earlier pages must not be half-applied");
  });

  await check("the next healthy run catches up and advances the cursor", async () => {
    engine.state.failChangesAt = null;
    const r = await run("&limit=2");
    assert.equal(r.ran, true);
    assert.equal(r.alertsCreated, 2);
    assert.equal((await state()).cursor, "2026-08-12|n2");
    assert.equal((await state()).last_seen_date, "2026-08-12");
  });

  await check("the default page size is used when none is given", async () => {
    engine.state.changesCalls.length = 0;
    await run();
    assert.equal(engine.state.changesCalls[0].limit, "500");
  });
} finally {
  db.close();
  await app.stop();
  await engine.close();
}
process.exit(finish());
