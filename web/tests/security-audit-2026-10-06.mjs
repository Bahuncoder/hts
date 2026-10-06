/** Security regressions: PASS means the audited vulnerability is prevented.
 * Uses a production app, scratch DB, fake Google and fake engine only.
 * Run: node tests/security-audit-2026-10-06.mjs
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { startApp, fakeServer, fakeEngine, json, suite } from "./harness.mjs";
import { loadLib } from "./tsload.mjs";
import { sessionTokenHash } from "./sessionfixture.mjs";

const google = await fakeServer(3516, async (req, res) => {
  if (req.url === "/token") return json(res, 200, { access_token: "fake-owner" });
  if (req.url === "/userinfo") return json(res, 200, {
    sub: "google-owner", email: "owner@example.test", email_verified: true,
  });
  return json(res, 404, {});
});
const engine = await fakeEngine(3517);
const app = await startApp({ port: 3515, env: {
  SITE_URL: "http://127.0.0.1:3515",
  HTSDESK_API: "http://127.0.0.1:3517",
  HTSDESK_API_KEY: "fake-engine-key",
  STRIPE_SECRET_KEY: "sk_test_fake", STRIPE_WEBHOOK_SECRET: "fake-webhook-secret",
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
  args: [sessionTokenHash("attacker-session"), "preclaimed", expiry] });
const s = suite();
let ownerCookie;
await c.execute({ sql: "INSERT INTO api_key(id,account_id,name,prefix,hash,created_at) VALUES(?,?,?,?,?,?)",
  args: ["attacker-key", "preclaimed", "old", "old", "old-hash", new Date().toISOString()] });
await c.execute({ sql: "INSERT INTO auth_token(token_hash,kind,account_id,expires_at,created_at) VALUES(?,?,?,?,?)",
  args: ["old-reset", "password_reset", "preclaimed", expiry, new Date().toISOString()] });

await s.check("OAuth ownership transition replaces unverified password and revokes existing credentials", async () => {
  const begin = await fetch(`${app.base}/api/auth/google`, { redirect: "manual" });
  const state = new URL(begin.headers.get("location")).searchParams.get("state");
  const cookie = begin.headers.getSetCookie().find(x => x.startsWith("htsdesk_oauth_state=")).split(";", 1)[0];
  const callback = await fetch(`${app.base}/api/auth/google/callback?code=fake&state=${encodeURIComponent(state)}`,
    { redirect: "manual", headers: { cookie } });
  assert.equal(callback.status, 307);
  assert.ok(callback.headers.getSetCookie().some(x => x.startsWith("htsdesk_session=")));
  const row = (await c.execute("SELECT * FROM account WHERE id='preclaimed'")).rows[0];
  assert.ok(row.email_verified_at);
  assert.notEqual(row.password_hash, hash);
  assert.equal(row.google_subject, "google-owner");
  ownerCookie = callback.headers.getSetCookie().find(x => x.startsWith("htsdesk_session=")).split(";", 1)[0];
  assert.ok((await c.execute("SELECT revoked_at FROM api_key WHERE id='attacker-key'")).rows[0].revoked_at);
  assert.equal((await c.execute("SELECT count(*) AS n FROM auth_token WHERE account_id='preclaimed'")).rows[0].n, 0);
  assert.equal((await c.execute({ sql: "SELECT count(*) AS n FROM session WHERE token=?", args: [sessionTokenHash("attacker-session")] })).rows[0].n, 0);
});

await s.check("audit rejects sibling-origin simple POST without spending account quota", async () => {
  const res = await fetch(`${app.base}/api/audit`, { method: "POST", headers: {
    cookie: ownerCookie, origin: "http://127.0.0.1:3516",
    "sec-fetch-site": "same-site", "content-type": "text/plain",
  }, body: JSON.stringify({ items: [{ description: "cotton shirt", country: "China", value: 100 }] }) });
  assert.equal(res.status, 403);
  assert.equal((await c.execute({ sql: "SELECT coalesce(sum(cost),0) AS n FROM usage_event WHERE scope='audit_requests' AND subject=?",
    args: ["account:preclaimed"] })).rows[0].n, 0);
});

await s.check("database session digest cannot authenticate as a browser credential", async () => {
  const token = (await c.execute("SELECT token FROM session WHERE account_id='preclaimed'")).rows[0].token;
  const res = await fetch(`${app.base}/api/catalogues/export?id=missing`, { headers: { cookie: `htsdesk_session=${token}` } });
  assert.equal(res.status, 401);
  assert.notEqual(token, ownerCookie.split("=")[1]);
  const valid = await fetch(`${app.base}/api/catalogues/export?id=missing`, { headers: { cookie: ownerCookie } });
  assert.equal(valid.status, 404, "the browser secret still authenticates");
});

process.env.HTSDESK_ACCOUNTS_DB = app.dbPath;
process.env.HTSDESK_API = "http://127.0.0.1:3517";
delete process.env.TURSO_DATABASE_URL;
const budget = await loadLib("budget");
const cap = { requests: { max: 1, windowMs: 60000 }, items: { max: 1, windowMs: 86400000 } };
await s.check("shared account quota holds under eight concurrent charges with different item leases", async () => {
  const subject = "account:quota-race";
  const leases = await Promise.all(Array.from({ length: 8 }, (_, i) => budget.acquireLease(`${subject}:item:${i}`)));
  assert.ok(leases.every(Boolean));
  const charges = await Promise.all(leases.map(() => budget.chargeAudit(subject, cap, 1)));
  const admitted = charges.filter(x => x.ok).length;
  assert.equal(admitted, 1);
  assert.equal(charges.filter(x => !x.ok).length, 7);
  const rows = await c.execute({ sql: "SELECT sum(cost) AS n FROM usage_event WHERE subject=? AND scope='audit_requests'", args: [subject] });
  console.log(`  race evidence: ${admitted} admitted; stored ${rows.rows[0].n}; allowed 1`);
  await Promise.all(leases.map(release => release()));
});

await s.check("real concurrent corrections spend only the account's one remaining request", async () => {
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
  assert.equal(work, 1);
  assert.equal(total, 10);
  console.log(`  correction evidence: ${work} engine calls with one remaining; total ${total}/10`);
});

await s.check("duplicate refunds cannot delete a later reservation", async () => {
  const large = { requests: { max: 10, windowMs: 60000 }, items: { max: 10, windowMs: 86400000 } };
  const first = await budget.chargeAudit("refund-isolation", large, 1);
  assert.ok(first.ok); await first.refund();
  const second = await budget.chargeAudit("refund-isolation", large, 1);
  assert.ok(second.ok); await first.refund();
  assert.equal((await c.execute("SELECT sum(cost) AS n FROM usage_event WHERE subject='refund-isolation' AND scope='audit_requests'")).rows[0].n, 1);
});

await s.check("API key ceiling is enforced atomically and revocation frees a slot", async () => {
  const { createApiKey, revokeApiKeyForAccount, listApiKeys } = await loadLib("apiKeys");
  const attempts = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => createApiKey("preclaimed", `key-${i}`, 1)));
  assert.equal(attempts.filter(x => x.status === "fulfilled").length, 1);
  const active = (await listApiKeys("preclaimed")).filter(x => !x.revoked_at);
  assert.equal(active.length, 1);
  await revokeApiKeyForAccount("preclaimed", active[0].id);
  assert.ok(await createApiKey("preclaimed", "replacement", 1));
});

await s.check("oversized webhook bodies are refused before signature verification", async () => {
  const res = await fetch(`${app.base}/api/stripe/webhook`, { method: "POST",
    headers: { "stripe-signature": "invalid" }, body: "x".repeat(262145) });
  assert.equal(res.status, 413);
  const streamed = await fetch(`${app.base}/api/stripe/webhook`, { method: "POST", duplex: "half",
    headers: { "stripe-signature": "invalid" }, body: new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode("x".repeat(262145))); controller.close();
    } }) });
  assert.equal(streamed.status, 413);
});

await s.check("checkout caps malformed and oversized authenticated bodies", async () => {
  const post = body => fetch(`${app.base}/api/billing/checkout`, { method: "POST",
    headers: { cookie: ownerCookie, origin: app.base, "content-type": "application/json" }, body });
  assert.equal((await post("x".repeat(4097))).status, 413);
  assert.equal((await post("null")).status, 400);
});

await s.check("migration invalidates recoverable legacy sessions and retains new digests", async () => {
  await c.execute({ sql: "INSERT INTO session(token,account_id,expires_at) VALUES(?,?,?)", args: ["legacy-raw", "preclaimed", expiry] });
  const fresh = await loadLib("store", { fresh: true });
  await fresh.db();
  assert.equal((await c.execute("SELECT count(*) AS n FROM session WHERE token='legacy-raw'")).rows[0].n, 0);
  const valid = await fetch(`${app.base}/api/catalogues/export?id=missing`, { headers: { cookie: ownerCookie } });
  assert.equal(valid.status, 404);
});

await s.check("quota is enforced across independent database clients", async () => {
  const instances = await Promise.all(Array.from({ length: 4 }, () => loadLib("budget", { fresh: true })));
  // Complete schema initialization before racing the transactions themselves.
  await Promise.all(instances.map(x => x.allow("warmup", crypto.randomUUID(), { max: 1, windowMs: 1000 })));
  const charges = await Promise.all(instances.map(x => x.chargeAudit("independent-quota", cap, 1)));
  assert.equal(charges.filter(x => x.ok).length, 1);
});

await app.stop();
await engine.close();
await google.close();
c.close();
process.exit(s.finish());
