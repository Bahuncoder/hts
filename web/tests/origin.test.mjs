/** Cookie-authenticated POST routes refuse requests from another origin
 *  (security audit 2026-10-06, S03). The check is sameOrigin(); this pins what
 *  it accepts and refuses. The routes themselves are covered by audit.test,
 *  billing.test and refundCheck.test, which send the origin a browser would.
 *  Run: node tests/origin.test.mjs
 */
import assert from "node:assert/strict";
import { suite } from "./harness.mjs";
import { loadLib } from "./tsload.mjs";

process.env.SITE_URL = "https://htsdesk.example";
const { sameOrigin } = await loadLib("requestOrigin");
const t = suite();

const post = (headers) => new Request("https://htsdesk.example/api/audit", { method: "POST", headers });

await t.check("the site's own origin is accepted", async () => {
  assert.equal(sameOrigin(post({ origin: "https://htsdesk.example" })), true);
});

await t.check("a request from another origin is refused, whatever its content type", async () => {
  assert.equal(sameOrigin(post({ origin: "https://evil.example", "content-type": "text/plain" })), false);
  assert.equal(sameOrigin(post({ origin: "https://htsdesk.example.evil.example" })), false);
});

await t.check("a sibling subdomain is refused: the origin must match exactly", async () => {
  assert.equal(sameOrigin(post({ origin: "https://app.htsdesk.example" })), false);
});

await t.check("a request with no origin is refused", async () => {
  assert.equal(sameOrigin(post({})), false);
});

await t.check("a malformed origin is refused, not thrown", async () => {
  assert.equal(sameOrigin(post({ origin: "not a url" })), false);
  assert.equal(sameOrigin(post({ origin: "ftp://htsdesk.example" })), false);
});

process.exit(t.finish());
