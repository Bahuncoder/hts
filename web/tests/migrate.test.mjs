/** An accounts database created before the webhook, outbox and diff-cursor
 *  columns existed must upgrade in place, keeping its rows and its meaning.
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
    for (const c of ["status", "attempts", "updated_at", "last_error"]) assert.ok((await cols("webhook_event")).has(c), c);
    for (const c of ["email_status", "email_attempts", "email_last_error", "email_claim", "email_claimed_at"]) {
      assert.ok((await cols("alert")).has(c), c);
    }
    assert.ok((await cols("diff_state")).has("cursor"));
    assert.ok((await cols("subscription")).has("stripe_subscription_created"));
    const ev = (await db.execute("SELECT * FROM webhook_event WHERE id='evt_old'")).rows[0];
    assert.equal(ev.status, "succeeded", "a pre-existing claim must not be replayed");
    assert.equal(ev.attempts, 1);
    assert.equal((await db.execute("SELECT plan FROM subscription WHERE account_id='old'")).rows[0].plan, "growth");
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
    await db.execute({ sql: "INSERT INTO session(token, account_id, expires_at) VALUES(?,?,?)",
      args: ["legacy-token", "old", new Date(Date.now() + 3_600_000).toISOString()] });
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
    } finally { await again.stop(); }
  });
} finally {
  db.close();
  await app.stop().catch(() => {});
  await engine.close();
}
process.exit(finish());
