/** Saved results must be server-produced: the audit proxy signs what the
 *  engine returned, and only a payload that verifies can be saved.
 *
 *  Production build on 3301 (and 3302/3303 for secret handling) against a fake
 *  engine on 3331 that follows the real /api/audit contract. Verification uses
 *  the real src/lib/auditProof.ts and auditModel.ts, transpiled, not copies.
 *  The save action's refusal of a tampered payload is driven through a real
 *  browser in review.test.mjs.
 *
 *  Run: node tests/proof.test.mjs
 */
import assert from "node:assert/strict";
import { fakeServer, json, readBody, startApp, suite, EMAIL_SECRET, ADMIN_TOKEN } from "./harness.mjs";
import { auditResponse } from "./auditfixture.mjs";
import { loadLib } from "./tsload.mjs";

const proof = await loadLib("auditProof");
const model = await loadLib("auditModel");

let mode = "ok";
const engine = await fakeServer(3331, async (req, res) => {
  const body = JSON.parse(await readBody(req));
  if (mode === "fail") return json(res, 500, { detail: "boom" });
  if (mode === "unprocessable") return json(res, 422, { detail: [{ msg: "bad" }] });
  if (mode === "garbage") { res.writeHead(200, { "content-type": "application/json" }); return res.end("not json"); }
  const out = auditResponse(body);
  if (mode === "unknown-status") out.lines[0].status = "quantum";
  return json(res, 200, out);
});

const env = { HTSDESK_API: "http://127.0.0.1:3331", HTSDESK_API_KEY: "k", HTSDESK_BEHIND_PROXY: "1" };
const app = await startApp({ port: 3301, env });
const items = [
  { row: 1, sku: "A", description: "ready shirt", country: "China", value: 1000 },
  { row: 2, sku: "B", description: "scope shirt", country: "China", value: 500 },
  { row: 3, sku: "C", description: "noclass", country: "China", value: 100 },
  { row: 4, sku: "D", description: "bad", country: "China", value: 0 },
];

let ip = 0;
async function audit(base = app.base, body = { items }) {
  const res = await fetch(`${base}/api/audit`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base, "x-forwarded-for": `203.0.113.${++ip}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null), res };
}

/** What the browser rebuilds from the response, as AuditClient does. entries
 *  and by_vessel are not the engine's own fields — the proxy adds them to
 *  the summary from the request, alongside dataset_revision/assumptions/mpf,
 *  which ARE — so they round-trip the same way. */
const signedFrom = (r) => ({
  v: 1, at: r.signed_at, dataset_revision: r.summary.dataset_revision,
  assumptions: r.summary.assumptions, mpf: r.summary.mpf,
  entries: r.summary.entries, by_vessel: r.summary.by_vessel,
  lines: r.lines.map((l) => model.projectLine(l)),
});

const { check, finish } = suite();
const clone = (x) => structuredClone(x);

try {
  await check("the audit route returns a proof over the engine's response, and leaves it intact", async () => {
    const r = await audit();
    assert.equal(r.status, 200);
    assert.match(r.body.proof, /^[A-Za-z0-9_-]{43}$/, "an HMAC-SHA256 as base64url");
    assert.ok(Number.isFinite(Date.parse(r.body.signed_at)));
    const direct = auditResponse({ items });
    assert.deepEqual(r.body.lines, direct.lines, "lines pass through unchanged");
    // entries/by_vessel are added by the proxy (from the request, which
    // named neither, so its own defaults: 1 and true) — everything else in
    // the engine's own summary passes through untouched.
    assert.deepEqual(r.body.summary, { ...direct.summary, entries: 1, by_vessel: true },
      "summary passes through unchanged, plus the two request-level fields the proxy adds");
  });

  await check("the proof verifies with the configured secret (EMAIL over ADMIN)", async () => {
    const r = (await audit()).body;
    assert.equal(proof.verifyAudit(signedFrom(r), r.proof, EMAIL_SECRET), true);
    assert.equal(proof.verifyAudit(signedFrom(r), r.proof, ADMIN_TOKEN), false,
      "the admin token is only the last fallback");
  });

  await check("a modified line, or a modified total, fails verification", async () => {
    const r = (await audit()).body;
    const edits = {
      "duty lowered": (s) => { s.lines[1].duty = 1; },
      "status flipped to ready": (s) => { s.lines[1].status = "ready"; },
      "hts changed": (s) => { s.lines[0].hts = "0101.21.00.10"; },
      "error line rewritten as priced": (s) => { s.lines[3].status = "ready"; s.lines[3].duty = 0; },
      "warning removed": (s) => { s.lines[1].warnings = []; },
      "line dropped": (s) => { s.lines.splice(2, 1); },
      "line duplicated": (s) => { s.lines.push(clone(s.lines[0])); },
      "lines reordered": (s) => { s.lines.reverse(); },
      "row renumbered": (s) => { s.lines[0].row = 99; },
      "dataset revision changed": (s) => { s.dataset_revision = "other"; },
      "MPF changed": (s) => { s.mpf = 0; },
      "assumption text changed": (s) => { s.assumptions = ["Nothing to see"]; },
      "timestamp moved": (s) => { s.at = new Date().toISOString().replace(/\d\dZ$/, "59Z"); },
    };
    for (const [name, edit] of Object.entries(edits)) {
      const s = signedFrom(r);
      edit(s);
      assert.equal(proof.verifyAudit(s, r.proof, EMAIL_SECRET), false, name);
    }
  });

  await check("a proof made with another secret, a truncated or missing proof, all fail", async () => {
    const r = (await audit()).body;
    const s = signedFrom(r);
    const forged = proof.signAudit(s, "attacker-secret");
    assert.notEqual(forged, r.proof);
    assert.equal(proof.verifyAudit(s, forged, EMAIL_SECRET), false);
    for (const bad of [undefined, null, "", 0, {}, r.proof.slice(1), r.proof + "A", r.proof.toLowerCase()]) {
      assert.equal(proof.verifyAudit(s, bad, EMAIL_SECRET), false, String(bad));
    }
    assert.equal(proof.verifyAudit(s, r.proof, null), false, "no secret verifies nothing");
  });

  await check("a field outside the signed projection cannot carry data into a save", () => {
    const l = model.projectLine({ row: 1, sku: "", description: "d", country: "C", hts: null,
      status: "ready", injected: "'; DROP TABLE catalogue;--", suggested: [{ hts: "x" }] });
    assert.equal("injected" in l, false);
    assert.equal("suggested" in l, false);
  });

  await check("the proof does not depend on key order", () => {
    assert.equal(model.canonicalJson({ b: 1, a: { d: 2, c: [{ z: 1, y: undefined, x: 2 }] } }),
      model.canonicalJson({ a: { c: [{ x: 2, z: 1 }], d: 2 }, b: 1 }));
  });

  await check("a failed, invalid or unreadable engine response carries no proof", async () => {
    for (const m of ["fail", "unprocessable", "garbage"]) {
      mode = m;
      const r = await audit();
      assert.equal(r.body?.proof, undefined, m);
    }
    mode = "ok";
  });

  await check("a response the engine contract does not allow is returned unsigned, and logged", async () => {
    mode = "unknown-status";
    const r = await audit();
    mode = "ok";
    assert.equal(r.status, 200);
    assert.equal(r.body.proof, undefined);
    assert.match(app.log(), /not in the expected shape/);
  });

  await check("the secret comes from HTSDESK_SIGNING_SECRET first", async () => {
    const other = await startApp({ port: 3302, env: { ...env, HTSDESK_SIGNING_SECRET: "signing-secret-a" } });
    try {
      const r = (await audit(other.base)).body;
      assert.equal(proof.verifyAudit(signedFrom(r), r.proof, "signing-secret-a"), true);
      assert.equal(proof.verifyAudit(signedFrom(r), r.proof, EMAIL_SECRET), false);
    } finally { await other.stop(); }
  });

  await check("production with no secret configured returns the audit unsigned and logs an error", async () => {
    const bare = await startApp({ port: 3303, env: { ...env, HTSDESK_ADMIN_TOKEN: "", HTSDESK_EMAIL_SECRET: "", HTSDESK_SIGNING_SECRET: "" } });
    try {
      const r = await audit(bare.base);
      assert.equal(r.status, 200, "the customer still gets their numbers");
      assert.equal(r.body.proof, undefined);
      assert.equal(r.body.lines.length, items.length);
      assert.match(bare.log(), /HTSDESK_SIGNING_SECRET .* is not set/);
    } finally { await bare.stop(); }
  });

  await check("outside production a fixed development secret is used; in production none is invented", () => {
    const saved = { ...process.env };
    try {
      for (const k of ["HTSDESK_SIGNING_SECRET", "HTSDESK_EMAIL_SECRET", "HTSDESK_ADMIN_TOKEN"]) delete process.env[k];
      process.env.NODE_ENV = "development";
      assert.ok(proof.signingSecret(), "dev fallback");
      process.env.NODE_ENV = "production";
      assert.equal(proof.signingSecret(), null);
      process.env.HTSDESK_ADMIN_TOKEN = "  ";
      assert.equal(proof.signingSecret(), null, "blank is not a secret");
      process.env.HTSDESK_ADMIN_TOKEN = "t";
      assert.equal(proof.signingSecret(), "t");
      process.env.HTSDESK_EMAIL_SECRET = "e";
      assert.equal(proof.signingSecret(), "e");
      process.env.HTSDESK_SIGNING_SECRET = "s";
      assert.equal(proof.signingSecret(), "s");
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
} finally {
  await app.stop().catch(() => {});
  await engine.close();
}
process.exit(finish());
