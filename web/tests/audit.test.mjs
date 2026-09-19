/** The public audit proxy and the classify page, as shipped.
 *
 *  Production build on 3203 with a scratch database and a fake engine on 3233.
 *  HTSDESK_BEHIND_PROXY=1 lets each test present its own client address, so
 *  budgets do not bleed between checks. Signed-in callers are given a real
 *  session row.
 *
 *  Run: node tests/audit.test.mjs
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { fakeEngine, seedAccount, startApp, suite } from "./harness.mjs";

const engine = await fakeEngine(3233);
const app = await startApp({
  port: 3203,
  env: {
    HTSDESK_API: "http://127.0.0.1:3233", HTSDESK_API_KEY: "engine-key",
    HTSDESK_BEHIND_PROXY: "1",
  },
});
const db = app.db();

let ipSeq = 0;
const newIp = () => `198.51.100.${++ipSeq}`;
const items = (n, description = "cotton t-shirt") =>
  Array.from({ length: n }, () => ({ description, country: "China", value: 10 }));

async function post(body, { ip = newIp(), cookie, raw } = {}) {
  const res = await fetch(`${app.base}/api/audit`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip,
               ...(cookie ? { cookie } : {}) },
    body: raw ?? JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, headers: res.headers, body: parsed, text };
}

async function signedIn(plan) {
  const id = `acct-${plan}-${++ipSeq}`;
  await seedAccount(db, { id, plan });
  const token = crypto.randomBytes(16).toString("hex");
  await db.execute({
    sql: "INSERT INTO session(token, account_id, expires_at) VALUES(?,?,?)",
    args: [token, id, new Date(Date.now() + 3_600_000).toISOString()],
  });
  return { id, cookie: `htsdesk_session=${token}`, subject: `account:${id}` };
}

const used = async (subject, scope) => (await db.execute({
  sql: "SELECT coalesce(sum(cost),0) AS n FROM usage_event WHERE subject = ? AND scope = ?",
  args: [subject, scope],
})).rows[0].n;
const preload = (subject, scope, cost, minutesAgo = 1) => db.execute({
  sql: "INSERT INTO usage_event(scope, subject, at, cost) VALUES(?,?,?,?)",
  args: [scope, subject, new Date(Date.now() - minutesAgo * 60_000).toISOString(), cost],
});

/** Raw request, for bodies that fetch would refuse to send as written. */
function rawPost({ headers, chunks, waitMs = 3000 }) {
  return new Promise((resolve) => {
    const req = http.request({
      host: "127.0.0.1", port: 3203, path: "/api/audit", method: "POST",
      headers: { "x-forwarded-for": newIp(), "content-type": "application/json", ...headers },
    });
    const timer = setTimeout(() => { req.destroy(); resolve({ status: "timeout" }); }, waitMs);
    let written = 0;
    req.on("response", (res) => {
      clearTimeout(timer); res.resume();
      resolve({ status: res.statusCode, writtenAtResponse: written }); req.destroy();
    });
    req.on("error", () => { /* the server may hang up while we are still writing */ });
    (async () => {
      for (const c of chunks) {
        if (!req.write(c)) await new Promise((r) => req.once("drain", r));
        written += 1;
        await new Promise((r) => setTimeout(r, 50));
      }
      req.end();
    })();
  });
}

const { check, finish } = suite();

try {
  await check("malformed bodies are 400s and never reach the engine", async () => {
    const before = engine.state.auditCalls;
    for (const raw of ["null", "[]", "42", '"x"', "{}", '{"items":"no"}', '{"items":[1]}',
                       '{"items":[null]}', '{"items":[[]]}', '{"items":[]}', "not json", ""]) {
      const r = await post(null, { raw });
      assert.equal(r.status, 400, `body ${JSON.stringify(raw)} gave ${r.status}`);
      assert.ok(r.body?.detail);
    }
    assert.equal(engine.state.auditCalls, before);
  });

  await check("a declared oversize body is refused before it is read", async () => {
    const r = await rawPost({
      headers: { "content-length": "5000000" },
      chunks: [Buffer.from('{"items":[')],  // never completes the declared length
    });
    assert.equal(r.status, 413);
  });

  await check("an oversize chunked body is cut off while streaming", async () => {
    const before = engine.state.auditCalls;
    const chunk = Buffer.alloc(500_000, "a");
    const r = await rawPost({
      headers: { "transfer-encoding": "chunked" },
      chunks: Array(20).fill(chunk),
    });
    assert.equal(r.status, 413);
    assert.ok(r.writtenAtResponse < 20, `refused only after the whole body arrived (${r.writtenAtResponse} chunks)`);
    assert.equal(engine.state.auditCalls, before);
  });

  await check("the engine key is attached to a valid request", async () => {
    const r = await post({ items: items(2) });
    assert.equal(r.status, 200);
    assert.equal(engine.state.auditKeys.at(-1), "engine-key");
  });

  await check("anonymous callers get 3 audits per 10 minutes, then a 429 with Retry-After", async () => {
    const ip = newIp();
    const calls = engine.state.auditCalls;
    for (let i = 0; i < 3; i++) assert.equal((await post({ items: items(25) }, { ip })).status, 200);
    const r = await post({ items: items(1) }, { ip });
    assert.equal(r.status, 429);
    const wait = Number(r.headers.get("retry-after"));
    assert.ok(wait >= 1 && wait <= 600, `Retry-After ${wait}`);
    assert.match(r.body.detail, /3 audits per 10 minutes/);
    assert.match(r.body.detail, /free account/i);
    assert.equal(r.body.upgrade, "/signup");
    assert.equal(engine.state.auditCalls - calls, 3, "the refused call must not reach the engine");
    assert.equal(await used(`client:${ip}`, "audit_items"), 75, "charged by submitted item count");
    assert.equal(await used(`client:${ip}`, "audit_requests"), 3, "refusals are not charged");
  });

  await check("anonymous callers are capped at 150 items per rolling day", async () => {
    const ip = newIp();
    const subject = `client:${ip}`;
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < 3; i++) assert.equal((await post({ items: items(25) }, { ip })).status, 200);
      // slide the request window forward; the item window stays
      await db.execute({
        sql: "UPDATE usage_event SET at = ? WHERE subject = ? AND scope = 'audit_requests'",
        args: [new Date(Date.now() - 20 * 60_000).toISOString(), subject],
      });
    }
    assert.equal(await used(subject, "audit_items"), 150);
    const r = await post({ items: items(1) }, { ip });
    assert.equal(r.status, 429);
    assert.match(r.body.detail, /daily allowance of 150/);
    assert.ok(Number(r.headers.get("retry-after")) > 3600);
  });

  await check("a free account gets 10 audits an hour and 500 items a day", async () => {
    const a = await signedIn("free");
    for (let i = 0; i < 10; i++) assert.equal((await post({ items: items(1) }, { cookie: a.cookie })).status, 200);
    const r = await post({ items: items(1) }, { cookie: a.cookie });
    assert.equal(r.status, 429);
    assert.match(r.body.detail, /10 audits per hour/);
    assert.equal(r.body.upgrade, "/pricing");

    const b = await signedIn("free");
    await preload(b.subject, "audit_items", 490);
    assert.equal((await post({ items: items(11) }, { cookie: b.cookie })).status, 429);
    assert.equal((await post({ items: items(10) }, { cookie: b.cookie })).status, 200);
  });

  await check("the budget follows the account, not the address", async () => {
    const a = await signedIn("free");
    await preload(a.subject, "audit_items", 500);
    assert.equal((await post({ items: items(1) }, { cookie: a.cookie, ip: newIp() })).status, 429);
    assert.equal((await post({ items: items(1) }, { cookie: a.cookie, ip: newIp() })).status, 429);
    assert.equal((await post({ items: items(1) })).status, 200, "an anonymous caller is unaffected");
  });

  await check("starter is limited to 3000 items a day, growth to 20000", async () => {
    const s = await signedIn("starter");
    await preload(s.subject, "audit_items", 2995);
    assert.equal((await post({ items: items(6) }, { cookie: s.cookie })).status, 429);
    assert.equal((await post({ items: items(5) }, { cookie: s.cookie })).status, 200);
    const busy = await signedIn("starter");
    for (let i = 0; i < 12; i++) assert.equal((await post({ items: items(1) }, { cookie: busy.cookie })).status, 200,
      "paid plans have no per-request cap");

    const g = await signedIn("growth");
    await preload(g.subject, "audit_items", 19995);
    const over = await post({ items: items(6) }, { cookie: g.cookie });
    assert.equal(over.status, 429);
    assert.equal(over.body.upgrade, undefined, "there is no higher plan to suggest");
    assert.equal((await post({ items: items(5) }, { cookie: g.cookie })).status, 200);
  });

  await check("only one audit runs at a time per caller", async () => {
    const ip = newIp();
    const slow = post({ items: items(1, "slow") }, { ip });
    await new Promise((r) => setTimeout(r, 300));
    const second = await post({ items: items(1) }, { ip });
    assert.equal(second.status, 429);
    assert.ok(Number(second.headers.get("retry-after")) >= 1);
    assert.match(second.body.detail, /already running/);
    assert.equal((await slow).status, 200);
    assert.equal((await post({ items: items(1) }, { ip })).status, 200, "the lease is released afterwards");
    assert.equal(await used(`client:${ip}`, "audit_requests"), 2, "the refused overlap was not charged");
    // other callers are not blocked meanwhile
    const other = post({ items: items(1, "slow") }, { ip: newIp() });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((await post({ items: items(1) })).status, 200);
    await other;
  });

  await check("a lease from a dead request expires", async () => {
    const ip = newIp();
    const held = (exp) => db.execute({
      sql: "INSERT OR REPLACE INTO usage_lease(subject, token, expires_at) VALUES(?,?,?)",
      args: [`client:${ip}`, "dead", exp],
    });
    await held(new Date(Date.now() + 60_000).toISOString());
    assert.equal((await post({ items: items(1) }, { ip })).status, 429);
    await held(new Date(Date.now() - 1000).toISOString());
    assert.equal((await post({ items: items(1) }, { ip })).status, 200);
  });

  await check("an engine failure is not billed to the caller", async () => {
    const ip = newIp();
    engine.state.auditStatus = 503;
    try {
      const r = await post({ items: items(10) }, { ip });
      assert.equal(r.status, 503);
    } finally { engine.state.auditStatus = 200; }
    assert.equal(await used(`client:${ip}`, "audit_items"), 0);
    assert.equal(await used(`client:${ip}`, "audit_requests"), 0);
  });

  await check("the per-request product ceiling still applies", async () => {
    const r = await post({ items: items(26) });
    assert.equal(r.status, 413);
    assert.equal(r.body.upgrade, "/signup");
  });

  await check("the server-rendered classify path is limited to 30 searches a minute", async () => {
    const ip = newIp();
    // the page's fetch is cached on disk by URL, so make every query unique to this run
    const run = crypto.randomBytes(4).toString("hex");
    const before = engine.state.classifyCalls;
    const get = async (n) => (await fetch(`${app.base}/classify?q=widget-${run}-${n}`,
      { headers: { "x-forwarded-for": ip } })).text();
    for (let n = 0; n < 30; n++) assert.doesNotMatch(await get(n), /Too many searches/);
    assert.match(await get(30), /Too many searches/);
    assert.equal(engine.state.classifyCalls - before, 30, "the refused search must not reach the engine");
    const other = await (await fetch(`${app.base}/classify?q=fresh-${run}`,
      { headers: { "x-forwarded-for": newIp() } })).text();
    assert.doesNotMatch(other, /Too many searches/);
  });
} finally {
  db.close();
  await app.stop();
  await engine.close();
}
process.exit(finish());
