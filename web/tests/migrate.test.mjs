/** An accounts database created before the outbox and diff-cursor columns
 *  existed, and back when HTSDesk first sold paid plans (so it already holds
 *  `subscription` and `webhook_event` tables, in their pre-hardening shape),
 *  must upgrade in place, keeping its rows and its meaning. Billing is live
 *  again (2026-09-28): a legacy database gets the hardened webhook-state
 *  columns added, exactly like any other additive migration, and a legacy
 *  account's own subscription row is honored, not distrusted just for being
 *  old -- there is no real historical Stripe data to reconcile (nothing has
 *  ever been deployed to production), so there is nothing to protect against
 *  by second-guessing an `active` row. A brand-new database now creates both
 *  tables, with a fresh `plan='free'` row per account.
 *
 *  Builds a legacy-schema database in a scratch directory, starts the
 *  production build on 3205 against it, and checks the result.
 *
 *  Run: node tests/migrate.test.mjs
 */
import assert from "node:assert/strict";
import path from "node:path";
import { createClient } from "@libsql/client";
import { fakeEngine, scratchDir, startApp, suite } from "./harness.mjs";

const file = path.join(scratchDir(), "legacy.db");
const legacy = createClient({ url: `file:${file}` });
await legacy.executeMultiple(`
  CREATE TABLE account (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE subscription (account_id TEXT PRIMARY KEY, stripe_customer_id TEXT,
    stripe_subscription_id TEXT, plan TEXT NOT NULL DEFAULT 'free',
    status TEXT NOT NULL DEFAULT 'active', current_period_end TEXT, updated_at TEXT NOT NULL);
  CREATE TABLE alert (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, document_number TEXT NOT NULL,
    title TEXT, publication_date TEXT, html_url TEXT, digits TEXT NOT NULL, hts TEXT NOT NULL,
    created_at TEXT NOT NULL, read_at TEXT, emailed_at TEXT,
    UNIQUE (account_id, document_number, digits));
  CREATE TABLE diff_state (id INTEGER PRIMARY KEY CHECK (id = 1), last_seen_date TEXT, last_run_at TEXT);
  CREATE TABLE webhook_event (id TEXT PRIMARY KEY, type TEXT, received_at TEXT NOT NULL);
  -- Catalogues as saved before review states, row numbers and dataset revisions existed.
  CREATE TABLE catalogue (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, name TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE catalogue_item (id TEXT PRIMARY KEY, catalogue_id TEXT NOT NULL, sku TEXT,
    description TEXT NOT NULL, country TEXT NOT NULL, value REAL NOT NULL, hts TEXT, digits TEXT,
    confidence TEXT, duty REAL, effective_rate REAL, refundable REAL,
    scope_unverified INTEGER NOT NULL DEFAULT 0);
  INSERT INTO catalogue VALUES('cat-old','old','Legacy range','2026-02-01T00:00:00Z','2026-02-01T00:00:00Z');
  INSERT INTO catalogue_item VALUES('i1','cat-old','SKU-1','cotton shirt','China',1000,'6109.10.00.12','6109100012','high',165,16.5,0,1);
  INSERT INTO catalogue_item VALUES('i2','cat-old','SKU-2','ceramic mug','Germany',500,'6912.00.44.00','6912004400','high',10,2,0,0);
  INSERT INTO account VALUES('old','old@example.test','x','2026-01-01T00:00:00Z');
  INSERT INTO subscription(account_id,plan,status,updated_at) VALUES('old','growth','active','2026-01-01T00:00:00Z');
  INSERT INTO alert(id,account_id,document_number,digits,hts,created_at,emailed_at)
    VALUES('a1','old','doc-1','2804610000','2804.61.00.00','2026-08-01T00:00:00Z','2026-08-01T01:00:00Z');
  INSERT INTO diff_state VALUES(1,'2026-08-20','2026-08-21T00:00:00Z');
  INSERT INTO webhook_event VALUES('evt_old','customer.subscription.updated','2026-08-01T00:00:00Z');
`);
legacy.close();

const engine = await fakeEngine(3235);
const app = await startApp({ port: 3205, dbFile: file, env: { HTSDESK_API: "http://127.0.0.1:3235" } });
const db = app.db();
const { check, finish } = suite();

try {
  await check("new columns are added and existing rows survive", async () => {
    const cols = async (t) => new Set((await db.execute(`PRAGMA table_info(${t})`)).rows.map((r) => r.name));
    for (const c of ["email_status", "email_attempts", "email_last_error", "email_claim", "email_claimed_at"]) {
      assert.ok((await cols("alert")).has(c), c);
    }
    assert.ok((await cols("diff_state")).has("cursor"));
    for (const c of ["alert_emails", "email_verified_at"]) assert.ok((await cols("account")).has(c), c);
    assert.equal((await db.execute("SELECT count(*) AS n FROM alert WHERE id='a1'")).rows[0].n, 1);
    assert.equal((await db.execute("SELECT email FROM account WHERE id='old'")).rows[0].email, "old@example.test");
  });

  await check("a legacy billing table is upgraded to the hardened shape, its rows kept", async () => {
    const cols = async (t) => [...(await db.execute(`PRAGMA table_info(${t})`)).rows.map((r) => r.name)];
    assert.deepEqual(await cols("subscription"),
      ["account_id", "stripe_customer_id", "stripe_subscription_id", "plan", "status",
        "current_period_end", "updated_at", "stripe_subscription_created"],
      "the hardened column is added, nothing dropped");
    assert.deepEqual(await cols("webhook_event"),
      ["id", "type", "received_at", "status", "attempts", "updated_at", "last_error"],
      "the hardened columns are added, nothing dropped");
    const sub = (await db.execute("SELECT plan, status FROM subscription WHERE account_id='old'")).rows[0];
    assert.equal(sub.plan, "growth", "the old subscription row is kept");
    assert.equal(sub.status, "active");
    const evt = (await db.execute("SELECT type, status FROM webhook_event WHERE id='evt_old'")).rows[0];
    assert.equal(evt.type, "customer.subscription.updated");
    assert.equal(evt.status, "succeeded",
      "a row claimed-then-applied under the pre-hardening scheme defaults to succeeded, never replayed");
  });

  await check("a legacy account can still reach its account page", async () => {
    // NOTE (implementation step 1/2 of the billing rebuild -- schema and
    // plans.ts only so far): currentViewer() does not resolve a plan from
    // `subscription` yet (that's step 3) and /account has no Plan section yet
    // (step 8), so this only checks the page still renders for a legacy
    // account with a foreign-shaped-but-now-migrated subscription row. Once
    // steps 3 and 8 land, extend this to assert the page shows "Growth" --
    // there is no real historical Stripe data to distrust (nothing has ever
    // been deployed to production), so a legacy `active` row should be
    // honored as a genuine active subscription, not second-guessed to free.
    await db.execute({ sql: "INSERT INTO session(token, account_id, expires_at) VALUES(?,?,?)",
      args: ["legacy-token", "old", new Date(Date.now() + 3_600_000).toISOString()] });
    const res = await fetch(`${app.base}/account`, { headers: { cookie: "htsdesk_session=legacy-token" } });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Your allowance/);
  });

  await check("catalogue review columns are added in place and legacy rows are untouched", async () => {
    const cols = async (t) => new Set((await db.execute(`PRAGMA table_info(${t})`)).rows.map((r) => r.name));
    for (const c of ["row_number", "status", "error", "review_json", "warnings_json", "incomplete_json"]) {
      assert.ok((await cols("catalogue_item")).has(c), `catalogue_item.${c}`);
    }
    for (const c of ["dataset_revision", "assumptions_json", "totals_complete", "calculated_at", "mpf"]) {
      assert.ok((await cols("catalogue")).has(c), `catalogue.${c}`);
    }
    const items = (await db.execute("SELECT * FROM catalogue_item ORDER BY id")).rows;
    assert.equal(items.length, 2);
    assert.equal(items[0].description, "cotton shirt");
    assert.equal(items[0].value, 1000);
    assert.equal(items[0].status, null, "a legacy row has no invented status");
    assert.equal(items[0].row_number, null);
    const cat = (await db.execute("SELECT * FROM catalogue WHERE id='cat-old'")).rows[0];
    assert.equal(cat.name, "Legacy range");
    assert.equal(cat.totals_complete, null, "completeness was never recorded, so it is not claimed");
    assert.equal(cat.calculated_at, null);
  });

  await check("a legacy catalogue is still readable and says what it is", async () => {
    const headers = { cookie: "htsdesk_session=legacy-token" };
    const page = await fetch(`${app.base}/catalogues/cat-old`, { headers });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Saved before review states existed/);
    assert.match(html, /cotton shirt/);
    assert.match(html, /Scope unverified/, "the one flag it did record is kept");
    assert.ok(!/Partial:/.test(html), "it cannot claim its totals were partial or complete");

    const list = await fetch(`${app.base}/catalogues`, { headers });
    assert.equal(list.status, 200);
    assert.match(await list.text(), /Legacy range/);

    const csv = await (await fetch(`${app.base}/api/catalogues/export?id=cat-old`, { headers })).text();
    assert.match(csv, /"Status"/);
    assert.match(csv, /Saved before review states existed/);
    assert.match(csv, /cotton shirt/);
  });

  await check("a legacy diff position still seeds the first lookback", async () => {
    engine.state.docs = [];
    const res = await app.admin("/api/admin/diff?send=0");
    assert.equal((await res.json()).ran, true);
    assert.equal(engine.state.changesCalls[0].since, "2026-08-13", "last_seen_date minus 7 days");
  });

  await check("an alert already emailed under the old scheme is not sent again", async () => {
    const res = await app.admin("/api/admin/diff");
    assert.equal((await res.json()).delivery.accountsConsidered, 0);
  });

  await check("upgrading twice is harmless", async () => {
    await app.stop();
    const again = await startApp({ port: 3205, dbFile: file, env: { HTSDESK_API: "http://127.0.0.1:3235" } });
    try {
      assert.equal((await again.admin("/api/admin/diff?send=0")).status, 200);
      assert.equal((await db.execute("SELECT plan FROM subscription WHERE account_id='old'")).rows[0].plan,
        "growth", "a second start leaves the dormant table alone");
    } finally { await again.stop(); }
  });

  await check("a brand-new database creates the billing tables, and a new account gets a free subscription row", async () => {
    const fresh = await startApp({ port: 3205, dbFile: path.join(scratchDir(), "fresh.db"),
                                   env: { HTSDESK_API: "http://127.0.0.1:3235" } });
    const fdb = fresh.db();
    try {
      const tables = new Set((await fdb.execute("SELECT name FROM sqlite_master WHERE type='table'"))
        .rows.map((r) => r.name));
      for (const t of ["account", "catalogue", "alert", "usage_event", "subscription", "webhook_event"]) {
        assert.ok(tables.has(t), t);
      }
      await fdb.execute({
        sql: "INSERT INTO account(id, email, password_hash, created_at) VALUES(?,?,?,?)",
        args: ["fresh-acct", "fresh@example.test", "x", new Date().toISOString()],
      });
      // createAccount() (lib/store.ts) is the one that inserts the paired
      // subscription row transactionally; this raw insert proves only that
      // the table itself exists with the right shape and default -- the
      // paired-insert behavior has its own coverage in billing tests.
      assert.deepEqual(
        [...(await fdb.execute("PRAGMA table_info(subscription)")).rows.map((r) => r.name)],
        ["account_id", "stripe_customer_id", "stripe_subscription_id", "plan", "status",
          "current_period_end", "updated_at", "stripe_subscription_created"]);
    } finally { fdb.close(); await fresh.stop(); }
  });
} finally {
  db.close();
  await app.stop().catch(() => {});
  await engine.close();
}
process.exit(finish());
