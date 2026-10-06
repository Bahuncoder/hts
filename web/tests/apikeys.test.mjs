/** The public, versioned B2B API (app/api/v1/audit) and key management
 *  (lib/apiKeys.ts): bearer-key auth, plan gating, and metering independent
 *  of the web UI's own budget.
 *
 *  Production build on 3206 with a scratch database and a fake engine on 3236.
 *  Keys are created through the real createApiKey (loaded via tsload.mjs,
 *  pointed at the same database file the started app uses), not a
 *  hand-rolled duplicate of its insert -- so a regression in how a secret is
 *  hashed or stored is actually caught here.
 *
 *  Run: node tests/apikeys.test.mjs
 */
import assert from "node:assert/strict";
import { fakeEngine, seedAccount, startApp, suite } from "./harness.mjs";
import { loadLib } from "./tsload.mjs";

const engine = await fakeEngine(3236);
const app = await startApp({
  port: 3206,
  env: { HTSDESK_API: "http://127.0.0.1:3236", HTSDESK_API_KEY: "engine-key" },
});
const db = app.db();

// store.ts (and anything importing it, including apiKeys.ts) reads this env
// var once at module load, so it must be set before the first loadLib call --
// pointing the library code at the SAME scratch file the started app itself
// uses, not a fresh one of its own.
process.env.HTSDESK_ACCOUNTS_DB = app.dbPath;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;
const { createApiKey, hashApiKeySecret, revokeApiKeyForAccount } = await loadLib("apiKeys");

let seq = 0;
const items = (n, description = "cotton t-shirt") =>
  Array.from({ length: n }, () => ({ description, country: "China", value: 10 }));

async function account(plan = "growth") {
  const id = `acct-${++seq}`;
  await seedAccount(db, { id, plan });
  return id;
}

async function call(secret, body, { raw } = {}) {
  const res = await fetch(`${app.base}/api/v1/audit`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
    body: raw ?? JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, headers: res.headers, body: parsed };
}

const used = async (subject, scope) => (await db.execute({
  sql: "SELECT coalesce(sum(cost),0) AS n FROM usage_event WHERE subject = ? AND scope = ?",
  args: [subject, scope],
})).rows[0].n;

const { check, finish } = suite();

try {
  await check("createApiKey returns a secret once; only its hash is ever persisted", async () => {
    const id = await account();
    const created = await createApiKey(id, "prod integration");
    assert.match(created.secret, /^htsd_/);
    assert.equal(created.prefix, created.secret.slice(0, 12));

    const row = (await db.execute({
      sql: "SELECT hash, prefix FROM api_key WHERE id = ?", args: [created.id],
    })).rows[0];
    assert.equal(row.hash, hashApiKeySecret(created.secret));
    assert.notEqual(row.hash, created.secret);
    assert.equal(row.prefix, created.prefix);
  });

  await check("a missing or malformed Authorization header is refused", async () => {
    const none = await call(null, { items: items(1) });
    assert.equal(none.status, 401);
    const res = await fetch(`${app.base}/api/v1/audit`, {
      method: "POST", headers: { "content-type": "application/json", authorization: "not-bearer" },
      body: JSON.stringify({ items: items(1) }),
    });
    assert.equal(res.status, 401);
  });

  await check("an unknown key is refused", async () => {
    const r = await call("htsd_not-a-real-key", { items: items(1) });
    assert.equal(r.status, 401);
    assert.equal(r.body.error, "unauthorized");
  });

  await check("a revoked key is refused, indistinguishably from an unknown one", async () => {
    const id = await account();
    const { id: keyId, secret } = await createApiKey(id, "k");
    assert.equal((await call(secret, { items: items(1) })).status, 200);
    assert.equal(await revokeApiKeyForAccount(id, keyId), true);
    const r = await call(secret, { items: items(1) });
    assert.equal(r.status, 401);
  });

  await check("a free-plan account's key cannot reach the API", async () => {
    const id = await account("free");
    const { secret } = await createApiKey(id, "k");
    const r = await call(secret, { items: items(1) });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "forbidden");
    assert.match(r.body.detail, /not included on your plan/);
  });

  await check("a valid key on a paid plan is accepted", async () => {
    const id = await account("starter");
    const { secret } = await createApiKey(id, "k");
    const r = await call(secret, { items: items(3) });
    assert.equal(r.status, 200);
    assert.equal(engine.state.auditCalls > 0, true);
  });

  await check("malformed bodies are 400s and never reach the engine", async () => {
    const id = await account();
    const { secret } = await createApiKey(id, "k");
    const calls = engine.state.auditCalls;
    assert.equal((await call(secret, null, { raw: "not json" })).status, 400);
    assert.equal((await call(secret, {})).status, 400);
    assert.equal((await call(secret, { items: [] })).status, 400);
    assert.equal(engine.state.auditCalls, calls);
  });

  await check("the per-request ceiling matches the plan's productsPerAudit", async () => {
    const id = await account("starter");
    const { secret } = await createApiKey(id, "k");
    const over = await call(secret, { items: items(501) });
    assert.equal(over.status, 413);
    assert.match(over.body.detail, /501 products exceeds the 500 allowed/);
    assert.equal((await call(secret, { items: items(500) })).status, 200);
  });

  await check("metering is per-account, not per-key: two keys share one quota", async () => {
    const id = await account("starter");
    const a = await createApiKey(id, "key a");
    const b = await createApiKey(id, "key b");
    const subject = `account:${id}`;
    await call(a.secret, { items: items(10) });
    await call(b.secret, { items: items(10) });
    assert.equal(await used(subject, "api_items"), 20);
  });

  await check("API usage and web-UI usage are metered independently", async () => {
    const id = await account("starter");
    const { secret } = await createApiKey(id, "k");
    const subject = `account:${id}`;
    await db.execute({
      sql: "INSERT INTO usage_event(scope, subject, at, cost) VALUES(?,?,?,?)",
      args: ["audit_items", subject, new Date().toISOString(), 4_999],
    });
    // The web-UI budget is nearly exhausted, but the API's own daily quota
    // (a separate scope) must be untouched by it.
    const r = await call(secret, { items: items(100) });
    assert.equal(r.status, 200);
    assert.equal(await used(subject, "api_items"), 100);
    assert.equal(await used(subject, "audit_items"), 4_999, "API usage must not be recorded under the web scope");
  });

  await check("daily API item allowance is enforced, independent of the web ceiling", async () => {
    const id = await account("starter"); // api.itemsPerDay.max === 2_500
    const { secret } = await createApiKey(id, "k");
    const subject = `account:${id}`;
    await db.execute({
      sql: "INSERT INTO usage_event(scope, subject, at, cost) VALUES(?,?,?,?)",
      args: ["api_items", subject, new Date().toISOString(), 2_450],
    });
    const over = await call(secret, { items: items(100) });
    assert.equal(over.status, 429);
    assert.equal(over.body.error, "rate_limited");
    assert.match(over.body.detail, /Daily allowance of 2,500/);
    assert.ok(Number(over.headers.get("retry-after")) > 0);
    assert.equal((await call(secret, { items: items(50) })).status, 200);
  });

  await check("concurrent API calls from the same account serialize", async () => {
    const id = await account("starter");
    const { secret } = await createApiKey(id, "k");
    const slow = call(secret, { items: items(1, "slow") });
    await new Promise((r) => setTimeout(r, 300));
    const second = await call(secret, { items: items(1) });
    assert.equal(second.status, 429);
    assert.equal(second.body.error, "rate_limited");
    assert.equal((await slow).status, 200);
  });

  await check("the API lease does not block, or get blocked by, a web-UI audit", async () => {
    const id = await account("starter");
    const { secret } = await createApiKey(id, "k");
    const slowApi = call(secret, { items: items(1, "slow") });
    await new Promise((r) => setTimeout(r, 300));
    const web = await fetch(`${app.base}/api/audit`, {
      method: "POST", headers: { "content-type": "application/json", origin: app.base },
      body: JSON.stringify({ items: items(1) }),
    });
    assert.equal(web.status, 200, "a web audit (a different lease subject entirely) is unaffected");
    assert.equal((await slowApi).status, 200);
  });

  await check("an engine failure refunds the charge and normalizes the error, never leaking engine text", async () => {
    const id = await account("starter");
    const { secret } = await createApiKey(id, "k");
    const subject = `account:${id}`;
    const before = await used(subject, "api_items");
    engine.state.auditStatus = 500;
    const r = await call(secret, { items: items(2) });
    assert.equal(r.status, 502);
    assert.equal(r.body.error, "engine_unavailable");
    assert.doesNotMatch(JSON.stringify(r.body), /X-API-Key|forced failure/i);
    assert.equal(await used(subject, "api_items"), before, "a failed engine call must not be billed");
    engine.state.auditStatus = 200;
  });
} finally {
  db.close();
  await app.stop();
  await engine.close();
}
process.exit(finish());
