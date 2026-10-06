/** Audit probes: PASS means the documented vulnerability was reproduced.
 * Uses a production app, scratch DB, fake Google and fake engine only.
 * Run: node tests/security-audit-2026-10-06.mjs
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { startApp, fakeServer, fakeEngine, json, suite } from "./harness.mjs";
import { loadLib } from "./tsload.mjs";

const google = await fakeServer(3516, async (req, res) => {
  if (req.url === "/token") return json(res, 200, { access_token: "fake-owner" });
  if (req.url === "/userinfo") return json(res, 200, {
    email: "owner@example.test", email_verified: true,
  });
  return json(res, 404, {});
});
const engine = await fakeEngine(3517);
const app = await startApp({ port: 3515, env: {
  SITE_URL: "http://127.0.0.1:3515",
  HTSDESK_API: "http://127.0.0.1:3517",
  HTSDESK_API_KEY: "fake-engine-key",
  GOOGLE_CLIENT_ID: "fake-client", GOOGLE_CLIENT_SECRET: "fake-secret",
  GOOGLE_OAUTH_AUTH_URL: "http://127.0.0.1:3516/authorize",
  GOOGLE_OAUTH_TOKEN_URL: "http://127.0.0.1:3516/token",
  GOOGLE_OAUTH_USERINFO_URL: "http://127.0.0.1:3516/userinfo",
}});
const c = app.db();
const password = "attacker-chosen-passphrase";
const salt = crypto.randomBytes(16);
const hash = `scrypt$${salt.toString("hex")}$${crypto.scryptSync(password, salt, 64).toString("hex")}`;
const expiry = new Date(Date.now() + 86400000).toISOString();
await c.execute({ sql: "INSERT INTO account(id,email,password_hash,created_at) VALUES(?,?,?,?)",
  args: ["preclaimed", "owner@example.test", hash, new Date().toISOString()] });
await c.execute({ sql: "INSERT INTO session(token,account_id,expires_at) VALUES(?,?,?)",
  args: ["attacker-session", "preclaimed", expiry] });
const s = suite();

await s.check("OAuth marks a preclaimed account verified but preserves attacker password and session", async () => {
  const begin = await fetch(`${app.base}/api/auth/google`, { redirect: "manual" });
  const state = new URL(begin.headers.get("location")).searchParams.get("state");
  const cookie = begin.headers.getSetCookie().find(x => x.startsWith("htsdesk_oauth_state=")).split(";", 1)[0];
  const callback = await fetch(`${app.base}/api/auth/google/callback?code=fake&state=${encodeURIComponent(state)}`,
    { redirect: "manual", headers: { cookie } });
  assert.equal(callback.status, 307);
  assert.ok(callback.headers.getSetCookie().some(x => x.startsWith("htsdesk_session=")));
  const row = (await c.execute("SELECT * FROM account WHERE id='preclaimed'")).rows[0];
  assert.ok(row.email_verified_at);
  assert.equal(row.password_hash, hash);
  assert.equal((await c.execute("SELECT count(*) AS n FROM session WHERE token='attacker-session'")).rows[0].n, 1);
});

await s.check("audit accepts cross-origin simple text/plain POST with a session and spends victim quota", async () => {
  const res = await fetch(`${app.base}/api/audit`, { method: "POST", headers: {
    cookie: "htsdesk_session=attacker-session", origin: "https://untrusted.example.test",
    "sec-fetch-site": "same-site", "content-type": "text/plain",
  }, body: JSON.stringify({ items: [{ description: "cotton shirt", country: "China", value: 100 }] }) });
  assert.equal(res.status, 200);
  assert.equal((await c.execute({ sql: "SELECT sum(cost) AS n FROM usage_event WHERE scope='audit_requests' AND subject=?",
    args: ["account:preclaimed"] })).rows[0].n, 1);
});

await s.check("database session token is itself a reusable bearer credential", async () => {
  const token = (await c.execute("SELECT token FROM session WHERE token='attacker-session'")).rows[0].token;
  const res = await fetch(`${app.base}/api/catalogues/export?id=missing`, { headers: { cookie: `htsdesk_session=${token}` } });
  assert.equal(res.status, 404, "authenticated (anonymous request would be 401)");
});

process.env.HTSDESK_ACCOUNTS_DB = app.dbPath;
process.env.HTSDESK_API = "http://127.0.0.1:3517";
delete process.env.TURSO_DATABASE_URL;
const budget = await loadLib("budget");
const cap = { requests: { max: 1, windowMs: 60000 }, items: { max: 1, windowMs: 86400000 } };
await s.check("different item leases do not serialize a shared account budget: concurrent charges exceed cap=1", async () => {
  const subject = "account:quota-race";
  const leases = await Promise.all(Array.from({ length: 8 }, (_, i) => budget.acquireLease(`${subject}:item:${i}`)));
  assert.ok(leases.every(Boolean));
  const charges = await Promise.all(leases.map(() => budget.chargeAudit(subject, cap, 1)));
  const admitted = charges.filter(x => x.ok).length;
  assert.ok(admitted > 1, `only ${admitted} admitted; race not reproduced`);
  const rows = await c.execute({ sql: "SELECT sum(cost) AS n FROM usage_event WHERE subject=? AND scope='audit_requests'", args: [subject] });
  console.log(`  race evidence: ${admitted} admitted; stored ${rows.rows[0].n}; allowed 1`);
  await Promise.all(leases.map(release => release()));
});

await s.check("real proposeCorrection calls exceed the free account's ten-request allowance", async () => {
  const store = await loadLib("store");
  await store.createAccount("correction-race", "correction@example.test", hash);
  const now = new Date().toISOString();
  await c.execute({ sql: "INSERT INTO catalogue(id,account_id,name,created_at,updated_at) VALUES(?,?,?,?,?)",
    args: ["correction-cat", "correction-race", "Race", now, now] });
  for (let i = 0; i < 8; i++) {
    await c.execute({ sql: "INSERT INTO catalogue_item(id,catalogue_id,description,country,value,status) VALUES(?,?,?,?,?,?)",
      args: [`correction-item-${i}`, "correction-cat", "cotton shirt", "China", 100, "unclassified"] });
  }
  await c.execute({ sql: "INSERT INTO usage_event(scope,subject,at,cost) VALUES(?,?,?,?)",
    args: ["audit_requests", "account:correction-race", now, 9] });
  const { proposeCorrection } = await loadLib("correction");
  const before = engine.state.auditCalls;
  await Promise.all(Array.from({ length: 8 }, (_, i) => proposeCorrection(
    "correction-race", "correction-cat", `correction-item-${i}`, { hts: "6109.10.00.12" }, 0,
  )));
  const work = engine.state.auditCalls - before;
  const total = (await c.execute({ sql: "SELECT sum(cost) AS n FROM usage_event WHERE subject=? AND scope='audit_requests'",
    args: ["account:correction-race"] })).rows[0].n;
  assert.ok(work > 1, `${work} calls reached engine; race not reproduced`);
  assert.ok(total > 10);
  console.log(`  correction evidence: ${work} engine calls with one remaining; total ${total}/10`);
});

await app.stop();
await engine.close();
await google.close();
c.close();
process.exit(s.finish());
