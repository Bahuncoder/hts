/** /verify's own request bounds — separate from the browser-driven signup
 *  journey (authflow.test.mjs, journey.test.mjs), which need a real mail
 *  catcher and so are not part of the auto-running suite. This file only
 *  covers what a plain HTTP client hitting the route directly can exercise.
 *
 *  Found by an independent security review (2026-09-24,
 *  docs/SECURITY-AUDIT-2026-09-24.md, finding #6): the POST handler called
 *  the built-in request.formData() directly, which buffers the entire body
 *  before any application code sees it — no size bound, unlike every other
 *  route here that reads a request body. sameOrigin() is a browser-enforced
 *  CSRF check (it compares headers the caller sends), not a resource-abuse
 *  barrier: a non-browser client can set a matching Origin header freely and
 *  still reach an unbounded formData() call. Fixed by reading the body
 *  through the same capped reader every JSON route already uses
 *  (lib/requestBody.ts), then parsing the tiny `token` field out of it by
 *  hand.
 *
 *  Production build, scratch database. Run: node tests/verify.test.mjs
 */
import assert from "node:assert/strict";
import http from "node:http";
import { startApp, suite } from "./harness.mjs";

const PORT = 3496;
const app = await startApp({ port: PORT, env: { SITE_URL: `http://127.0.0.1:${PORT}` } });
const ORIGIN = `http://127.0.0.1:${PORT}`;

function rawPost({ headers, chunks, waitMs = 3000 }) {
  return new Promise((resolve) => {
    const req = http.request({
      host: "127.0.0.1", port: PORT, path: "/verify", method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded", ...headers },
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
        await new Promise((r) => setTimeout(r, 30));
      }
      req.end();
    })();
  });
}

const s = suite();

await s.check("GET with a well-shaped token shows the confirm page, not an auto-verify", async () => {
  const token = "a".repeat(43);
  const res = await fetch(`${app.base}/verify?token=${token}`, { redirect: "manual" });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /Confirm your email/);
  assert.match(body, /<form method="post">/, "verifying is a deliberate POST, not the GET itself");
});

await s.check("GET with a malformed token redirects to signup, no form shown", async () => {
  const res = await fetch(`${app.base}/verify?token=not-the-right-shape`, { redirect: "manual" });
  assert.equal(res.status, 303);
  assert.match(res.headers.get("location"), /\/signup\?verify=expired/);
});

await s.check("POST without a matching Origin is refused before the body is even read", async () => {
  const res = await fetch(`${app.base}/verify`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `token=${"a".repeat(43)}`,
  });
  assert.equal(res.status, 403);
});

await s.check("a declared oversize body is refused before it is read", async () => {
  const r = await rawPost({
    headers: { "content-length": "50000" },
    chunks: [Buffer.from("token=")], // never completes the declared length
  });
  assert.equal(r.status, 413);
});

await s.check("an oversize chunked body is cut off while streaming, not buffered in full first", async () => {
  const chunk = Buffer.alloc(1000, "a");
  const r = await rawPost({
    headers: { "transfer-encoding": "chunked" },
    chunks: Array(20).fill(chunk), // 20,000 bytes against a 4096-byte cap
  });
  assert.equal(r.status, 413);
  assert.ok(r.writtenAtResponse < 20, `refused only after the whole body arrived (${r.writtenAtResponse} chunks)`);
});

await s.check("a well-formed but wrong token still gets the ordinary 'expired' redirect, not an error", async () => {
  const res = await fetch(`${app.base}/verify`, {
    method: "POST", headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
    body: `token=${"b".repeat(43)}`, redirect: "manual",
  });
  assert.equal(res.status, 303);
  assert.match(res.headers.get("location"), /\/signup\?verify=expired/);
});

await app.stop();
process.exit(s.finish());
