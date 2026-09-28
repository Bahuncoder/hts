/** Watching a code on its own, from a code page rather than a catalogue.
 *
 *  Found by an independent review (2026-09-27): watchCode() used
 *  `INSERT OR IGNORE ... WHERE (SELECT count(*) ...) < MAX_STANDALONE_WATCHES`
 *  to cap standalone watches, but the caller awaited it and returned void --
 *  a click past the cap silently did nothing, with no error and no message
 *  anywhere in the app. Fix: watchCode() now returns whether the watch
 *  actually happened (`rowsAffected > 0`), and watchCodeAction redirects
 *  with `?watchError=cap` when it did not, which the code page renders.
 *
 *  Pure library function against a scratch embedded libSQL file (never
 *  data/accounts.db) -- no browser, no server. Run: node tests/watch.test.mjs
 */
import assert from "node:assert/strict";
import path from "node:path";
import { scratchDir, suite } from "./harness.mjs";
import { loadLib } from "./tsload.mjs";

process.env.HTSDESK_ACCOUNTS_DB = path.join(scratchDir("htsdesk-watch-"), "accounts.db");
delete process.env.TURSO_DATABASE_URL;

const { db, createAccount } = await loadLib("store");
const { watchCode, unwatchCode } = await loadLib("catalogues");
const { MAX_STANDALONE_WATCHES } = await loadLib("plans");
const c = await db();

const { check, finish } = suite();

await createAccount("acc1", "acc1@example.test", "scrypt$x$y");

await check("watching a new code returns true and is recorded", async () => {
  const ok = await watchCode("acc1", "1234.56.78");
  assert.equal(ok, true);
  const rows = await c.execute({
    sql: "SELECT count(*) AS n FROM watched_code WHERE account_id = ? AND catalogue_id IS NULL",
    args: ["acc1"],
  });
  assert.equal(Number(rows.rows[0].n), 1);
});

await check("watching a code already watched by this account returns false, harmlessly", async () => {
  const ok = await watchCode("acc1", "1234.56.78");
  assert.equal(ok, false, "a duplicate watch must not silently look like a new one");
});

await check(`the ${MAX_STANDALONE_WATCHES}th watch succeeds, the one past it is refused, not silently dropped`, async () => {
  await unwatchCode("acc1", "1234.56.78");
  for (let i = 0; i < MAX_STANDALONE_WATCHES; i++) {
    const hts = `${1000 + i}.00.00`;
    const ok = await watchCode("acc1", hts);
    assert.equal(ok, true, `watch ${i + 1} of ${MAX_STANDALONE_WATCHES} was refused early`);
  }
  const rows = await c.execute({
    sql: "SELECT count(*) AS n FROM watched_code WHERE account_id = ? AND catalogue_id IS NULL",
    args: ["acc1"],
  });
  assert.equal(Number(rows.rows[0].n), MAX_STANDALONE_WATCHES);

  const overCap = await watchCode("acc1", "9999.00.00");
  assert.equal(overCap, false, "a watch past the cap must report failure, not look like it worked");
  const after = await c.execute({
    sql: "SELECT count(*) AS n FROM watched_code WHERE account_id = ? AND catalogue_id IS NULL",
    args: ["acc1"],
  });
  assert.equal(Number(after.rows[0].n), MAX_STANDALONE_WATCHES, "the refused watch must not have been inserted anyway");
});

await check("another account's watches do not count toward this one's cap", async () => {
  await createAccount("acc2", "acc2@example.test", "scrypt$x$y");
  const ok = await watchCode("acc2", "8888.00.00");
  assert.equal(ok, true, "a fresh account must not inherit another account's exhausted cap");
});

process.exit(finish());
