/** Stripe webhook, driven through the real route.
 *
 *  Starts the production build on port 3200 with a scratch accounts database
 *  and a tiny fake Stripe API on 3210 that the Stripe SDK is pointed at, then
 *  posts correctly SIGNED events. What is asserted is the shipped handler:
 *  retries after a failure, genuine duplicates, and Stripe's lack of event
 *  ordering.
 *
 *  Run: node tests/billing.test.mjs   (builds first if the bundle is stale)
 */
import assert from "node:assert/strict";
import Stripe from "stripe";
import { fakeServer, json, seedAccount, startApp, suite } from "./harness.mjs";

const SECRET = "whsec_test_secret";
const ACCT = "acct_1";
const CUS = "cus_1";

const stripeState = { subs: new Map(), failing: new Set(), retrieveCalls: [] };
const sub = (id, { price = "price_growth", status = "active", created = 1000 } = {}) => ({
  id, object: "subscription", customer: CUS, status, created,
  metadata: { account_id: ACCT },
  items: { object: "list", data: [{ id: `si_${id}`, price: { id: price }, current_period_end: 1893456000 }] },
});

const fake = await fakeServer(3210, (req, res) => {
  const m = req.url.match(/^\/v1\/subscriptions\/([^/?]+)/);
  if (req.method !== "GET" || !m) return json(res, 404, { error: { message: "unhandled" } });
  stripeState.retrieveCalls.push(m[1]);
  if (stripeState.failing.has(m[1])) {
    return json(res, 400, { error: { type: "invalid_request_error", message: "forced failure" } });
  }
  const found = stripeState.subs.get(m[1]);
  return found
    ? json(res, 200, found)
    : json(res, 404, { error: { type: "invalid_request_error", code: "resource_missing", message: "gone" } });
});

const app = await startApp({
  port: 3200,
  env: {
    STRIPE_SECRET_KEY: "sk_test_fake", STRIPE_WEBHOOK_SECRET: SECRET,
    STRIPE_PRICE_STARTER: "price_starter", STRIPE_PRICE_GROWTH: "price_growth",
    STRIPE_API_HOST: "127.0.0.1", STRIPE_API_PORT: "3210", STRIPE_API_PROTOCOL: "http",
  },
});
const db = app.db();
await seedAccount(db, { id: ACCT, customer: CUS });

const signer = new Stripe("sk_test_unused");
let seq = 0;
const evt = (type, object, id = `evt_${++seq}`) => ({
  id, object: "event", type, data: { object }, created: 1000 + seq,
});
async function deliver(event, { secret = SECRET } = {}) {
  const payload = JSON.stringify(event);
  const res = await fetch(`${app.base}/api/stripe/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": signer.webhooks.generateTestHeaderString({ payload, secret }),
    },
    body: payload,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const row = async (sql, ...args) => (await db.execute({ sql, args })).rows[0];
const subscription = () => row("SELECT * FROM subscription WHERE account_id = ?", ACCT);
const eventRow = (id) => row("SELECT * FROM webhook_event WHERE id = ?", id);
const reset = async () => {
  await db.execute({
    sql: `UPDATE subscription SET plan='free', status='active', stripe_subscription_id=NULL,
            stripe_subscription_created=NULL, current_period_end=NULL WHERE account_id=?`,
    args: [ACCT],
  });
  stripeState.subs.clear(); stripeState.failing.clear(); stripeState.retrieveCalls.length = 0;
};

const { check, finish } = suite();

try {
  await check("an unsigned or wrongly signed request is refused", async () => {
    const payload = JSON.stringify(evt("customer.subscription.updated", sub("sub_x")));
    const none = await fetch(`${app.base}/api/stripe/webhook`, { method: "POST", body: payload });
    assert.equal(none.status, 400);
    assert.equal((await deliver(JSON.parse(payload), { secret: "whsec_other" })).status, 400);
    assert.equal(stripeState.retrieveCalls.length, 0, "nothing may run before the signature is verified");
  });

  await check("a forced failure is retried, not acknowledged as a duplicate", async () => {
    await reset();
    stripeState.subs.set("sub_A", sub("sub_A", { price: "price_growth" }));
    stripeState.failing.add("sub_A");
    const created = evt("customer.subscription.created", sub("sub_A"), "evt_retry");

    const first = await deliver(created);
    assert.equal(first.status, 500);
    assert.equal((await subscription()).plan, "free");
    const failed = await eventRow("evt_retry");
    assert.equal(failed.status, "failed");
    assert.equal(failed.attempts, 1);
    assert.match(failed.last_error, /forced failure/);

    stripeState.failing.clear();
    const redelivered = await deliver(created);
    assert.equal(redelivered.status, 200);
    assert.notEqual(redelivered.body.duplicate, true, "a failed event must be reprocessed");
    assert.equal((await subscription()).plan, "growth");
    const done = await eventRow("evt_retry");
    assert.equal(done.status, "succeeded");
    assert.equal(done.attempts, 2);
  });

  await check("a genuine duplicate is acknowledged without being applied again", async () => {
    // continues from the succeeded evt_retry
    await db.execute({ sql: "UPDATE subscription SET plan='starter' WHERE account_id=?", args: [ACCT] });
    const before = stripeState.retrieveCalls.length;
    const again = await deliver(evt("customer.subscription.created", sub("sub_A"), "evt_retry"));
    assert.equal(again.status, 200);
    assert.equal(again.body.duplicate, true);
    assert.equal((await subscription()).plan, "starter", "a duplicate must not re-apply");
    assert.equal(stripeState.retrieveCalls.length, before, "a duplicate must not call Stripe");
  });

  await check("an event another delivery is processing is refused with a non-2xx", async () => {
    const now = new Date().toISOString();
    await db.execute({
      sql: `INSERT INTO webhook_event(id,type,received_at,status,attempts,updated_at)
            VALUES('evt_busy','customer.subscription.updated',?, 'processing', 1, ?)`,
      args: [now, now],
    });
    const busy = await deliver(evt("customer.subscription.updated", sub("sub_A"), "evt_busy"));
    assert.equal(busy.status, 503);
    assert.equal((await eventRow("evt_busy")).attempts, 1, "a live claim must not be taken over");
  });

  await check("a stale processing claim is taken over and applied", async () => {
    await reset();
    stripeState.subs.set("sub_A", sub("sub_A"));
    await db.execute({
      sql: "UPDATE webhook_event SET updated_at=? WHERE id='evt_busy'",
      args: [new Date(Date.now() - 10 * 60_000).toISOString()],
    });
    const r = await deliver(evt("customer.subscription.updated", sub("sub_A"), "evt_busy"));
    assert.equal(r.status, 200);
    assert.equal((await subscription()).plan, "growth");
    const done = await eventRow("evt_busy");
    assert.equal(done.status, "succeeded");
    assert.equal(done.attempts, 2);
  });

  await check("a database error while claiming is a 500, never a duplicate", async () => {
    await reset();
    stripeState.subs.set("sub_A", sub("sub_A"));
    await db.execute("ALTER TABLE webhook_event RENAME TO webhook_event_away");
    let broken;
    try {
      broken = await deliver(evt("customer.subscription.updated", sub("sub_A"), "evt_dberr"));
    } finally {
      await db.execute("ALTER TABLE webhook_event_away RENAME TO webhook_event");
    }
    assert.equal(broken.status, 500);
    assert.equal((await subscription()).plan, "free");
    const healed = await deliver(evt("customer.subscription.updated", sub("sub_A"), "evt_dberr"));
    assert.equal(healed.status, 200);
    assert.equal((await subscription()).plan, "growth");
  });

  await check("an older update for the same subscription cannot undo an upgrade", async () => {
    await reset();
    // Stripe's authoritative state is the upgrade; the late event still
    // carries the earlier starter snapshot.
    stripeState.subs.set("sub_A", sub("sub_A", { price: "price_growth" }));
    const upgraded = await deliver(evt("customer.subscription.updated", sub("sub_A", { price: "price_growth" })));
    assert.equal(upgraded.status, 200);
    const stale = await deliver(evt("customer.subscription.updated", sub("sub_A", { price: "price_starter" })));
    assert.equal(stale.status, 200);
    assert.equal((await subscription()).plan, "growth");
  });

  await check("events about an old subscription cannot clobber the newer one", async () => {
    await reset();
    stripeState.subs.set("sub_old", sub("sub_old", { price: "price_starter", created: 1000 }));
    stripeState.subs.set("sub_new", sub("sub_new", { price: "price_growth", created: 2000 }));

    await deliver(evt("customer.subscription.updated", sub("sub_old")));
    assert.equal((await subscription()).plan, "starter");
    await deliver(evt("customer.subscription.created", sub("sub_new")));
    let now = await subscription();
    assert.equal(now.plan, "growth");
    assert.equal(now.stripe_subscription_id, "sub_new");

    await deliver(evt("customer.subscription.updated", sub("sub_old")));
    now = await subscription();
    assert.equal(now.stripe_subscription_id, "sub_new", "a late update for the old subscription");
    assert.equal(now.plan, "growth");

    const checkout = await deliver(evt("checkout.session.completed", {
      id: "cs_1", object: "checkout.session", client_reference_id: ACCT,
      customer: CUS, subscription: "sub_old",
    }));
    assert.equal(checkout.status, 200);
    assert.equal((await subscription()).stripe_subscription_id, "sub_new", "a late checkout for the old one");

    const deletedOld = await deliver(evt("customer.subscription.deleted", sub("sub_old", { status: "canceled" })));
    assert.equal(deletedOld.status, 200);
    now = await subscription();
    assert.equal(now.plan, "growth", "deleting the old subscription must not clear the new one");
    assert.equal(now.stripe_subscription_id, "sub_new");
    assert.equal(now.status, "active");
  });

  await check("deleting the current subscription downgrades the account", async () => {
    const r = await deliver(evt("customer.subscription.deleted", sub("sub_new", { status: "canceled" })));
    assert.equal(r.status, 200);
    const now = await subscription();
    assert.equal(now.plan, "free");
    assert.equal(now.status, "canceled");
    assert.equal(now.stripe_subscription_id, null);
  });

  await check("a newer active subscription replaces one that is no longer active", async () => {
    await reset();
    stripeState.subs.set("sub_p", sub("sub_p", { price: "price_starter", status: "past_due", created: 5000 }));
    stripeState.subs.set("sub_q", sub("sub_q", { price: "price_growth", created: 1 }));
    await deliver(evt("customer.subscription.updated", sub("sub_p")));
    await deliver(evt("customer.subscription.created", sub("sub_q")));
    const now = await subscription();
    assert.equal(now.stripe_subscription_id, "sub_q");
    assert.equal(now.plan, "growth");
  });

  await check("a subscription Stripe no longer has does not clear another one", async () => {
    // sub_q is current; sub_gone 404s on retrieve.
    const r = await deliver(evt("customer.subscription.updated", sub("sub_gone")));
    assert.equal(r.status, 200);
    assert.equal((await subscription()).stripe_subscription_id, "sub_q");
  });
} finally {
  db.close();
  await app.stop();
  await fake.close();
}
process.exit(finish());
