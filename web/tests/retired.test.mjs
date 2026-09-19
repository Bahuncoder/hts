/** The paid model is gone, and its old URLs must not half-work.
 *
 *  /pricing is a permanent redirect to the home page (old links and bookmarks),
 *  and the billing and Stripe webhook routes no longer exist: they answer 404
 *  for every method rather than being quietly accepted.
 *
 *  Production build on 3206 with a scratch database and a fake engine on 3236.
 *
 *  Run: node tests/retired.test.mjs
 */
import assert from "node:assert/strict";
import { fakeEngine, startApp, suite } from "./harness.mjs";

const engine = await fakeEngine(3236);
const app = await startApp({ port: 3206, env: { HTSDESK_API: "http://127.0.0.1:3236" } });
const { check, finish } = suite();

try {
  await check("/pricing permanently redirects to the home page", async () => {
    const res = await fetch(`${app.base}/pricing`, { redirect: "manual" });
    assert.equal(res.status, 308);
    assert.equal(new URL(res.headers.get("location"), app.base).pathname, "/");
    const followed = await fetch(`${app.base}/pricing`);
    assert.equal(followed.status, 200);
    assert.equal(new URL(followed.url).pathname, "/");
  });

  await check("the home page and navigation no longer offer pricing or a plan", async () => {
    const html = await (await fetch(`${app.base}/`)).text();
    assert.doesNotMatch(html, /href="\/pricing"/);
    assert.doesNotMatch(html, /Starter|Growth|\$99|\$499|Stripe|upgrade/i);
  });

  await check("the billing and webhook routes are gone (404 for every method)", async () => {
    for (const path of ["/api/billing/checkout", "/api/billing/portal", "/api/stripe/webhook"]) {
      for (const method of ["GET", "POST", "PUT", "DELETE"]) {
        const res = await fetch(`${app.base}${path}`, {
          method, redirect: "manual",
          ...(method === "GET" ? {} : { body: "{}", headers: { "content-type": "application/json" } }),
        });
        assert.equal(res.status, 404, `${method} ${path} gave ${res.status}`);
      }
    }
  });

  await check("the retired routes never touched the database", async () => {
    const db = app.db();
    try {
      const tables = new Set((await db.execute("SELECT name FROM sqlite_master WHERE type='table'"))
        .rows.map((r) => r.name));
      assert.ok(!tables.has("subscription") && !tables.has("webhook_event"));
    } finally { db.close(); }
  });
} finally {
  await app.stop();
  await engine.close();
}
process.exit(finish());
