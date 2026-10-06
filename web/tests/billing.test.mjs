import { sessionTokenHash } from "./sessionfixture.mjs";
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
import crypto from "node:crypto";
import Stripe from "stripe";
import { fakeServer, json, seedAccount, startApp, suite } from "./harness.mjs";

const SECRET = "whsec_test_secret";
const ACCT = "acct_1";
const CUS = "cus_1";

const stripeState = {
  subs: new Map(), failing: new Set(), retrieveCalls: [],
  customersCreated: [], checkoutSessions: [], portalSessions: [],
};
const sub = (id, { price = "price_growth", status = "active", created = 1000 } = {}) => ({
  id, object: "subscription", customer: CUS, status, created,
  metadata: { account_id: ACCT },
  items: { object: "list", data: [{ id: `si_${id}`, price: { id: price }, current_period_end: 1893456000 }] },
});

const fake = await fakeServer(3210, async (req, res) => {
  const subMatch = req.url.match(/^\/v1\/subscriptions\/([^/?]+)/);
  if (req.method === "GET" && subMatch) {
    stripeState.retrieveCalls.push(subMatch[1]);
    if (stripeState.failing.has(subMatch[1])) {
      return json(res, 400, { error: { type: "invalid_request_error", message: "forced failure" } });
    }
    const found = stripeState.subs.get(subMatch[1]);
    return found
      ? json(res, 200, found)
      : json(res, 404, { error: { type: "invalid_request_error", code: "resource_missing", message: "gone" } });
  }
  if (req.method === "POST" && req.url.startsWith("/v1/customers")) {
    const id = `cus_${stripeState.customersCreated.length + 1}`;
    stripeState.customersCreated.push(id);
    return json(res, 200, { id, object: "customer" });
  }
  if (req.method === "POST" && req.url.startsWith("/v1/checkout/sessions")) {
    const id = `cs_${stripeState.checkoutSessions.length + 1}`;
    stripeState.checkoutSessions.push(id);
    return json(res, 200, { id, object: "checkout.session", url: `https://stripe.test/checkout/${id}` });
  }
  if (req.method === "POST" && req.url.startsWith("/v1/billing_portal/sessions")) {
    const id = `bps_${stripeState.portalSessions.length + 1}`;
    stripeState.portalSessions.push(id);
    return json(res, 200, { id, object: "billing_portal.session", url: `https://stripe.test/portal/${id}` });
  }
  return json(res, 404, { error: { message: "unhandled" } });
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

let acctSeq = 0;
async function signedInAccount() {
  const id = `acct_checkout_${++acctSeq}`;
  await seedAccount(db, { id });
  const token = crypto.randomBytes(16).toString("hex");
  await db.execute({
    sql: "INSERT INTO session(token, account_id, expires_at) VALUES(?,?,?)",
    args: [sessionTokenHash(token), id, new Date(Date.now() + 3_600_000).toISOString()],
  });
  return { id, cookie: `htsdesk_session=${token}` };
}
async function checkoutRequest(plan, { cookie } = {}) {
  const res = await fetch(`${app.base}/api/billing/checkout`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: app.base, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ plan }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function portalRequest({ cookie } = {}) {
  const res = await fetch(`${app.base}/api/billing/portal`, {
    method: "POST",
    headers: { origin: app.base, ...(cookie ? { cookie } : {}) },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

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

  await check("checkout is refused signed out, and for an unknown plan", async () => {
    assert.equal((await checkoutRequest("growth")).status, 401);
    const acct = await signedInAccount();
    assert.equal((await checkoutRequest("enterprise", { cookie: acct.cookie })).status, 400);
  });

  await check("checkout creates a Stripe customer once and reuses it on a second checkout", async () => {
    const acct = await signedInAccount();
    const before = stripeState.customersCreated.length;
    const first = await checkoutRequest("starter", { cookie: acct.cookie });
    assert.equal(first.status, 200);
    assert.ok(first.body.url);
    assert.equal(stripeState.customersCreated.length, before + 1, "a first checkout creates one customer");
    const customerId = (await row("SELECT stripe_customer_id FROM subscription WHERE account_id = ?", acct.id))
      .stripe_customer_id;
    assert.ok(customerId);

    const second = await checkoutRequest("growth", { cookie: acct.cookie });
    assert.equal(second.status, 200);
    assert.equal(stripeState.customersCreated.length, before + 1, "a second checkout must not create another customer");
    const stillSame = (await row("SELECT stripe_customer_id FROM subscription WHERE account_id = ?", acct.id))
      .stripe_customer_id;
    assert.equal(stillSame, customerId);
  });

  await check("portal is refused signed out, and with no billing account yet", async () => {
    assert.equal((await portalRequest()).status, 401);
    const acct = await signedInAccount();
    assert.equal((await portalRequest({ cookie: acct.cookie })).status, 400);
  });

  await check("portal succeeds once a Stripe customer exists", async () => {
    const acct = await signedInAccount();
    await checkoutRequest("starter", { cookie: acct.cookie });
    const res = await portalRequest({ cookie: acct.cookie });
    assert.equal(res.status, 200);
    assert.ok(res.body.url);
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
