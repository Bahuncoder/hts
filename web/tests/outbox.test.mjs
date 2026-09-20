/** Alert email outbox, through the real admin delivery route.
 *
 *  Production build on 3202 with a scratch database, a fake engine (no new
 *  documents) on 3232 and a fake mail provider on 3242. Alerts are seeded
 *  straight into the alert table, so what runs is sendAlertDigests as shipped:
 *  provider failure and recovery, exact-id stamping, concurrent runs, the
 *  retry cap, and the deliberate skips.
 *
 *  Run: node tests/outbox.test.mjs
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { fakeEngine, fakeServer, json, readBody, seedAccount, startApp, suite } from "./harness.mjs";

const engine = await fakeEngine(3232);
const mail = { mode: "ok", delayMs: 0, sent: [], onMessage: null };
const provider = await fakeServer(3242, async (req, res) => {
  const body = JSON.parse(await readBody(req));
  if (mail.delayMs) await new Promise((r) => setTimeout(r, mail.delayMs));
  if (mail.mode === "fail") return json(res, 500, { error: "provider down" });
  mail.sent.push({ to: body.to[0], subject: body.subject, text: body.text });
  await mail.onMessage?.(body);
  return json(res, 200, { id: "m" });
});

const baseEnv = { HTSDESK_API: "http://127.0.0.1:3232" };
let app = await startApp({
  port: 3202,
  env: { ...baseEnv, RESEND_API_KEY: "re_test", RESEND_API_URL: "http://127.0.0.1:3242/emails" },
});
let db = app.db();
await seedAccount(db, { id: "acct" });
await seedAccount(db, { id: "acct2" });
await seedAccount(db, { id: "acct3" });
await seedAccount(db, { id: "quiet", alertEmails: 0 });

async function addAlert(account, n, extra = {}) {
  const id = crypto.randomUUID();
  await db.execute({
    sql: `INSERT INTO alert(id,account_id,document_number,title,publication_date,html_url,digits,hts,created_at)
          VALUES(?,?,?,?,?,?,?,?,?)`,
    args: [id, account, n, `Title ${n}`, "2026-08-10", `https://www.federalregister.gov/d/${n}`,
      "2804610000", "2804.61.00.00", new Date().toISOString()],
  });
  return id;
}
const alerts = async () =>
  (await db.execute("SELECT * FROM alert ORDER BY document_number")).rows;
const reset = async () => {
  await db.execute("DELETE FROM alert");
  await db.execute("DELETE FROM email_log");
  mail.mode = "ok"; mail.delayMs = 0; mail.sent.length = 0; mail.onMessage = null;
};
const deliver = async (server = app) => (await (await server.admin("/api/admin/diff")).json()).delivery;

const { check, finish } = suite();

try {
  await check("a provider outage keeps the alerts queued and records the attempt", async () => {
    await reset();
    await addAlert("acct", "a1"); await addAlert("acct", "a2");
    mail.mode = "fail";
    const r = await deliver();
    assert.equal(r.failed, 1);
    assert.equal(r.sent, 0);
    for (const a of await alerts()) {
      assert.equal(a.emailed_at, null, "must not be stamped as delivered");
      assert.equal(a.email_attempts, 1);
      assert.match(a.email_last_error, /resend 500/);
      assert.equal(a.email_claim, null, "the claim is released for the retry");
    }
  });

  await check("after recovery the same alerts are delivered and stamped", async () => {
    mail.mode = "ok";
    const r = await deliver();
    assert.equal(r.sent, 1);
    assert.equal(mail.sent.length, 1);
    assert.match(mail.sent[0].text, /Title a1/);
    assert.match(mail.sent[0].text, /Title a2/);
    for (const a of await alerts()) {
      assert.ok(a.emailed_at);
      assert.equal(a.email_status, "sent");
    }
    assert.equal((await deliver()).accountsConsidered, 0, "nothing left to send");
  });

  await check("only the alerts in the digest are stamped, not one inserted mid-send", async () => {
    await reset();
    await addAlert("acct", "b1");
    let late;
    mail.onMessage = async () => { late = await addAlert("acct", "b2-late"); };
    const r = await deliver();
    assert.equal(r.sent, 1);
    assert.doesNotMatch(mail.sent[0].text, /b2-late/);
    const byNumber = Object.fromEntries((await alerts()).map((a) => [a.document_number, a]));
    assert.ok(byNumber.b1.emailed_at);
    assert.equal(byNumber["b2-late"].emailed_at, null, "it was never emailed, so it must stay pending");
    mail.onMessage = null;
    const next = await deliver();
    assert.equal(next.sent, 1);
    assert.match(mail.sent[1].text, /b2-late/);
    assert.ok((await alerts()).every((a) => a.emailed_at));
    assert.ok(late);
  });

  await check("concurrent runs send each account's batch once", async () => {
    await reset();
    for (const acct of ["acct", "acct2"]) for (const n of ["c1", "c2", "c3"]) await addAlert(acct, `${acct}-${n}`);
    mail.delayMs = 400;
    const [x, y] = await Promise.all([deliver(), deliver()]);
    assert.equal(mail.sent.length, 2, `one digest per account, got ${mail.sent.map((m) => m.to)}`);
    assert.deepEqual(mail.sent.map((m) => m.to).sort(), ["acct2@example.test", "acct@example.test"]);
    assert.equal(x.sent + y.sent, 2);
    assert.ok((await alerts()).every((a) => a.emailed_at && a.email_status === "sent"));
  });

  await check("a claim held by a live run is left alone; a stale one is taken over", async () => {
    await reset();
    const id = await addAlert("acct", "s1");
    await db.execute({
      sql: "UPDATE alert SET email_claim='other-run', email_claimed_at=? WHERE id=?",
      args: [new Date().toISOString(), id],
    });
    assert.equal((await deliver()).accountsConsidered, 0);
    assert.equal(mail.sent.length, 0);
    await db.execute({
      sql: "UPDATE alert SET email_claimed_at=? WHERE id=?",
      args: [new Date(Date.now() - 10 * 60_000).toISOString(), id],
    });
    assert.equal((await deliver()).sent, 1, "a crashed run must not strand its alerts");
  });

  await check("delivery is abandoned after five failed attempts and says so", async () => {
    await reset();
    await addAlert("acct", "f1");
    mail.mode = "fail";
    for (let i = 1; i <= 4; i++) {
      const r = await deliver();
      assert.equal(r.failed, 1);
      assert.equal(r.failedPermanent, 0);
    }
    const last = await deliver();
    assert.equal(last.failed, 1);
    assert.equal(last.failedPermanent, 1);
    const [a] = await alerts();
    assert.equal(a.email_attempts, 5);
    assert.equal(a.email_status, "failed_permanent");
    assert.ok(a.emailed_at, "stamped so it is not retried forever");
    assert.equal((await deliver()).accountsConsidered, 0);
    assert.match(app.log(), /abandoned after 5 attempts/);
  });

  await check("the alerts page tells an account its emails were abandoned, and only that account", async () => {
    await reset();
    const session = async (account) => {
      const token = crypto.randomBytes(16).toString("hex");
      await db.execute({ sql: "INSERT INTO session(token, account_id, expires_at) VALUES(?,?,?)",
        args: [token, account, new Date(Date.now() + 3_600_000).toISOString()] });
      return token;
    };
    const page = async (account) => {
      const res = await fetch(`${app.base}/alerts`, { headers: { cookie: `htsdesk_session=${await session(account)}` } });
      assert.equal(res.status, 200);
      return (await res.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    };
    const a1 = await addAlert("acct", "u1");
    const a2 = await addAlert("acct", "u2");
    await addAlert("acct2", "u3");
    const stamp = (id, status) => db.execute({
      sql: "UPDATE alert SET emailed_at = ?, email_status = ?, email_attempts = 5 WHERE id = ?",
      args: [new Date().toISOString(), status, id] });
    await stamp(a1, "failed_permanent");
    await stamp(a2, "failed_permanent");
    const acct2Alert = (await alerts()).find((a) => a.document_number === "u3");
    await stamp(acct2Alert.id, "sent");

    const mine = await page("acct");
    assert.match(mine, /2 alert emails could not be delivered after several attempts — they are still listed here\./);
    assert.match(mine, /Title u1/); assert.match(mine, /Title u2/); // still listed
    assert.match(mine, /Last successful check: [A-Z][a-z]{2} \d{1,2}, \d{4}, .* UTC\./, "the last successful check is stated with its time");
    const other = await page("acct2");
    assert.doesNotMatch(other, /could not be delivered/, "another account's failures are not shown");
    await stamp(a2, "sent");
    assert.match(await page("acct"), /1 alert email could not be delivered after several attempts — it is still listed here\./);
    await stamp(a1, "sent");
    assert.doesNotMatch(await page("acct"), /could not be delivered/);
  });

  await check("every account is emailed; an opt-out is stamped and distinguishable from a failure", async () => {
    await reset();
    await addAlert("acct3", "p1"); await addAlert("quiet", "q1");
    const r = await deliver();
    assert.equal(r.sent, 1, "an account is emailed with no plan of any kind");
    assert.equal(r.skippedOptedOut, 1);
    assert.equal(r.failed, 0);
    assert.equal("skippedNoPlan" in r, false, "there is no plan skip any more");
    const by = Object.fromEntries((await alerts()).map((a) => [a.document_number, a]));
    assert.equal(by.p1.email_status, "sent");
    assert.equal(by.q1.email_status, "skipped_opt_out");
    assert.ok(by.p1.emailed_at && by.q1.emailed_at);
    assert.deepEqual(mail.sent.map((m) => m.to), ["acct3@example.test"]);
  });

  await check("a legacy skipped_plan alert stays as history and is not sent again", async () => {
    await reset();
    const id = await addAlert("acct3", "old1");
    await db.execute({
      sql: "UPDATE alert SET emailed_at = ?, email_status = 'skipped_plan' WHERE id = ?",
      args: [new Date().toISOString(), id],
    });
    const r = await deliver();
    assert.equal(r.accountsConsidered, 0);
    const [a] = await alerts();
    assert.equal(a.email_status, "skipped_plan", "history is not rewritten");
    assert.equal(mail.sent.length, 0);
  });

  await app.stop();
  db.close();
  app = await startApp({ port: 3202, env: baseEnv });
  db = app.db();

  await check("with no provider configured alerts are stamped as skipped, not replayed later", async () => {
    await reset();
    await addAlert("acct", "n1");
    const r = await deliver();
    assert.equal(r.provider, "none");
    assert.equal(r.skippedNoProvider, 1);
    assert.equal(r.failed, 0);
    const [a] = await alerts();
    assert.equal(a.email_status, "skipped_no_provider");
    assert.ok(a.emailed_at);
  });
} finally {
  db.close();
  await app.stop();
  await provider.close();
  await engine.close();
}
process.exit(finish());
