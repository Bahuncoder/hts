import assert from "node:assert/strict";
import crypto from "node:crypto";
import { startApp, seedAccount } from "./harness.mjs";
const app = await startApp({ port: 3478, env: { HTSDESK_API: "http://127.0.0.1:3499" } });
const db = app.db();
try {
  await seedAccount(db, { id: "owner" });
  await seedAccount(db, { id: "other" });
  const now = new Date().toISOString();
  for (const id of ["owner", "other"]) await db.execute({ sql: "INSERT INTO session VALUES(?,?,?)", args: [id + "-session", id, "2099-01-01T00:00:00.000Z"] });
  await db.execute({ sql: "INSERT INTO catalogue(id,account_id,name,created_at,updated_at,totals_complete,mpf) VALUES(?,?,?,?,?,?,?)", args: ["cat", "owner", "<script>alert(1)</script>", now, now, null, 0] });
  const owner = { cookie: "htsdesk_session=owner-session" };
  const other = { cookie: "htsdesk_session=other-session" };
  const costs = { freight: 25.5, insurance: 0, brokerage: 10, portFees: 0, other: 0 };
  const save = (headers, data = costs) => fetch(app.base + "/api/catalogues/costs", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ id: "cat", costs: data }) });
  assert.equal((await save(owner)).status, 403);
  assert.equal((await save({ ...other, origin: app.base })).status, 404);
  assert.equal((await save({ ...owner, origin: app.base }, { ...costs, freight: -1 })).status, 400);
  assert.equal((await save({ ...owner, origin: app.base })).status, 200);
  assert.equal((await fetch(app.base + "/api/catalogues/evidence?id=cat")).status, 401);
  assert.equal((await fetch(app.base + "/api/catalogues/evidence?id=cat", { headers: other })).status, 404);
  const exported = await fetch(app.base + "/api/catalogues/evidence?id=cat", { headers: owner });
  assert.equal(exported.headers.get("cache-control"), "no-store");
  const body = await exported.json();
  assert.equal(body.landed_cost.landed, 35.5);
  assert.equal(body.calculation.totals_complete, null);
  assert.equal(body.landed_cost.partial, true);
  const report = await fetch(app.base + "/catalogues/cat/report", { headers: owner });
  assert.equal(report.status, 200);
  assert.equal(report.headers.get("x-frame-options"), "DENY");
  assert.match(await report.text(), /&lt;script&gt;/);
  const deniedReport = await fetch(app.base + "/catalogues/cat/report", { headers: other });
  // Next can stream its shell before notFound(), yielding HTTP 200 with a
  // not-found boundary. Assert that private report content is absent.
  const deniedHtml = await deniedReport.text();
  assert.doesNotMatch(deniedHtml, /Cost summary \(USD\)/);
  assert.doesNotMatch(deniedHtml, /&lt;script&gt;alert/);
  const token = crypto.randomBytes(32).toString("base64url");
  await db.execute({ sql: "INSERT INTO auth_token(token_hash,kind,email,expires_at,created_at) VALUES(?,?,?,?,?)", args: [crypto.createHash("sha256").update(token).digest("hex"), "email_verify", "owner@example.test", "2099-01-01T00:00:00.000Z", now] });
  const landing = await fetch(app.base + "/verify?token=" + token, { headers: other });
  assert.equal(landing.headers.get("set-cookie"), null);
  const verify = await fetch(app.base + "/verify", { method: "POST", headers: { ...other, origin: app.base }, body: new URLSearchParams({ token }), redirect: "manual" });
  assert.equal(verify.status, 303);
  assert.equal(verify.headers.get("set-cookie"), null);
  assert.ok(verify.headers.get("location").endsWith("/login"));
  console.log("HTTP checks passed: cost saving, validation, CSRF, ownership, exports, report escaping and verification session preservation.");
} finally { db.close(); await app.stop(); }
