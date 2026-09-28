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

async function signedIn(plan = "free") {
  const id = `acct-${++ipSeq}`;
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
    assert.match(r.body.detail, /Create a free account for a larger allowance/);
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

  await check("a signed-in account gets 10 audits an hour and 2,000 items a day", async () => {
    const a = await signedIn();
    for (let i = 0; i < 10; i++) assert.equal((await post({ items: items(1) }, { cookie: a.cookie })).status, 200);
    const r = await post({ items: items(1) }, { cookie: a.cookie });
    assert.equal(r.status, 429);
    assert.match(r.body.detail, /10 audits per hour/);
    assert.match(r.body.detail, /rolling basis/);
    assert.match(r.body.detail, /Try again in \d+ (minutes|seconds)/);
    const wait = Number(r.headers.get("retry-after"));
    assert.ok(wait >= 1 && wait <= 3600, `Retry-After ${wait}`);
    assert.doesNotMatch(r.text, /upgrade|pricing|plan|free account/i, "nothing larger to sell or move to");
    assert.equal(r.body.upgrade, undefined);

    const b = await signedIn();
    await preload(b.subject, "audit_items", 1801);
    const over = await post({ items: items(200) }, { cookie: b.cookie });
    assert.equal(over.status, 429);
    assert.match(over.body.detail, /daily allowance of 2,000/);
    assert.match(over.body.detail, /rolling basis/);
    assert.doesNotMatch(over.text, /upgrade|pricing/i);
    assert.equal((await post({ items: items(199) }, { cookie: b.cookie })).status, 200);
    assert.equal(await used(b.subject, "audit_items"), 2000);
  });

  await check("the budget follows the account, not the address", async () => {
    const a = await signedIn();
    await preload(a.subject, "audit_items", 2000);
    assert.equal((await post({ items: items(1) }, { cookie: a.cookie, ip: newIp() })).status, 429);
    assert.equal((await post({ items: items(1) }, { cookie: a.cookie, ip: newIp() })).status, 429);
    assert.equal((await post({ items: items(1) })).status, 200, "an anonymous caller is unaffected");
  });

  await check("an account's usage is independent of another account on the same address", async () => {
    const ip = newIp();
    const a = await signedIn();
    const b = await signedIn();
    await preload(a.subject, "audit_items", 2000);
    assert.equal((await post({ items: items(1) }, { cookie: a.cookie, ip })).status, 429);
    assert.equal((await post({ items: items(1) }, { cookie: b.cookie, ip })).status, 200);
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

  await check("the per-request ceiling is 25 products anonymous, 200 signed in", async () => {
    const calls = engine.state.auditCalls;
    const anon = await post({ items: items(26) });
    assert.equal(anon.status, 413);
    assert.match(anon.body.detail, /26 products exceeds the 25 allowed without an account/);
    assert.match(anon.body.detail, /Create a free account for a larger allowance/);
    assert.doesNotMatch(anon.text, /upgrade|pricing/i);
    assert.equal((await post({ items: items(25) })).status, 200);

    const a = await signedIn();
    const over = await post({ items: items(201) }, { cookie: a.cookie });
    assert.equal(over.status, 413);
    assert.match(over.body.detail, /201 products exceeds the 200 allowed in one audit/);
    assert.doesNotMatch(over.text, /upgrade|pricing|free account/i);
    assert.equal((await post({ items: items(200) }, { cookie: a.cookie })).status, 200);
    assert.equal(engine.state.auditCalls - calls, 2, "over-ceiling requests never reach the engine");
    assert.equal(await used(a.subject, "audit_items"), 200, "the refused 201 was not charged");
  });

  await check("a growth-plan account's per-request ceiling never exceeds what the engine accepts", async () => {
    // The engine hard-rejects any audit request over 1,000 items outright
    // (api/main.py's AuditRequest.items max_length), regardless of caller.
    // Growth must never promise, or forward, more than that in one request.
    const g = await signedIn("growth");
    const over = await post({ items: items(1001) }, { cookie: g.cookie });
    assert.equal(over.status, 413);
    assert.match(over.body.detail, /1001 products exceeds the 1,000 allowed in one audit/);
    assert.equal((await post({ items: items(1000) }, { cookie: g.cookie })).status, 200);
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
