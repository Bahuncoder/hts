/** Sign in with Google: the authorization-code round trip, against a fake
 *  Google standing in for accounts.google.com (GOOGLE_OAUTH_*_URL overrides).
 *
 *  The whole feature is server routes plus a single <a href> link — nothing
 *  here needs client-side JS, so plain fetch with manual redirects (and a
 *  tiny hand-rolled cookie jar) exercises the real route handlers without
 *  the cost of a browser.
 *
 *  Safety: a scratch accounts database in a fresh temp directory, never
 *  data/accounts.db. Run: node tests/google-auth.test.mjs
 */
import assert from "node:assert/strict";
import { startApp, fakeServer, readBody, json, suite } from "./harness.mjs";

const PORT = 3491;
const GOOGLE_PORT = 3496;

// code -> profile the fake token/userinfo endpoints hand back. The access
// token IS the code (this is a fake, not real Google), so userinfo can look
// the profile back up without a real token store.
const profiles = new Map();

const google = await fakeServer(GOOGLE_PORT, async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/token" && req.method === "POST") {
    const body = new URLSearchParams(await readBody(req));
    const code = body.get("code");
    if (!profiles.has(code)) return json(res, 400, { error: "invalid_grant" });
    return json(res, 200, { access_token: code });
  }
  if (url.pathname === "/userinfo" && req.method === "GET") {
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const profile = profiles.get(token);
    if (!profile) return json(res, 401, { error: "invalid_token" });
    return json(res, 200, { sub: profile.email.toLowerCase(), ...profile });
  }
  return json(res, 404, { error: "not found" });
});

const app = await startApp({
  port: PORT,
  env: {
    SITE_URL: `http://127.0.0.1:${PORT}`,
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
    GOOGLE_OAUTH_AUTH_URL: `http://127.0.0.1:${GOOGLE_PORT}/authorize`,
    GOOGLE_OAUTH_TOKEN_URL: `http://127.0.0.1:${GOOGLE_PORT}/token`,
    GOOGLE_OAUTH_USERINFO_URL: `http://127.0.0.1:${GOOGLE_PORT}/userinfo`,
  },
});
const db = app.db();

/** This app only ever sets one cookie of interest per request chain, so
 *  "last write wins" per name is all a test jar needs. */
function jar() {
  const cookies = new Map();
  return {
    header() { return [...cookies].map(([k, v]) => `${k}=${v}`).join("; "); },
    absorb(res) {
      for (const line of res.headers.getSetCookie()) {
        const pair = line.split(";", 1)[0];
        const eq = pair.indexOf("=");
        cookies.set(pair.slice(0, eq), pair.slice(eq + 1));
      }
    },
  };
}

const isRedirect = (res) => res.status >= 300 && res.status < 400;

/** Starts the flow and returns the round-trip `state` plus the jar holding
 *  the state cookie — never fetches the real Google URL, since `state`
 *  travels in the redirect target's own query string. */
async function beginFlow(next) {
  const c = jar();
  const res = await fetch(
    `${app.base}/api/auth/google${next ? `?next=${encodeURIComponent(next)}` : ""}`,
    { redirect: "manual" },
  );
  assert.ok(isRedirect(res), "starting the flow redirects to Google");
  c.absorb(res);
  const location = new URL(res.headers.get("location"));
  assert.equal(location.origin, `http://127.0.0.1:${GOOGLE_PORT}`, "redirects to the (fake) Google");
  const state = location.searchParams.get("state");
  assert.ok(state, "state travels in the redirect URL");
  return { state, jar: c };
}

async function finishFlow({ state, jar: c }, params = {}, { withCookie = true } = {}) {
  const url = new URL(`${app.base}/api/auth/google/callback`);
  if (state !== null) url.searchParams.set("state", state);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    redirect: "manual",
    headers: withCookie ? { cookie: c.header() } : {},
  });
  c.absorb(res);
  return res;
}

const hasSessionCookie = (res) => res.headers.getSetCookie().some((c) => c.startsWith("htsdesk_session="));
const errorOf = (res) => new URL(res.headers.get("location")).searchParams.get("error");
const pathOf = (res) => new URL(res.headers.get("location")).pathname;

const s = suite();

await s.check("a brand-new Google account is created and signed in", async () => {
  const flow = await beginFlow("/catalogues");
  profiles.set("code-new-1", { email: "fresh@example.test", email_verified: true, name: "Fresh" });
  const res = await finishFlow(flow, { code: "code-new-1" });
  assert.ok(isRedirect(res));
  assert.equal(pathOf(res), "/catalogues", "honours the next param that started the flow");
  assert.ok(hasSessionCookie(res), "a session cookie is set");
  const row = await db.execute({ sql: "SELECT * FROM account WHERE email = ?", args: ["fresh@example.test"] });
  assert.equal(row.rows.length, 1, "the account now exists");
  assert.ok(row.rows[0].email_verified_at, "created already verified — Google vouched for the email");
});

await s.check("signing in again with the same Google account reuses it", async () => {
  const flow = await beginFlow();
  profiles.set("code-new-1-again", { email: "fresh@example.test", email_verified: true, name: "Fresh" });
  const res = await finishFlow(flow, { code: "code-new-1-again" });
  assert.ok(isRedirect(res));
  const rows = await db.execute({ sql: "SELECT * FROM account WHERE email = ?", args: ["fresh@example.test"] });
  assert.equal(rows.rows.length, 1, "no duplicate account");
});

await s.check("an unverified password account is reclaimed and its old password removed", async () => {
  await db.execute({
    sql: "INSERT INTO account(id,email,password_hash,created_at) VALUES(?,?,?,?)",
    args: ["existing-1", "existing@example.test", "scrypt$aa$bb", new Date().toISOString()],
  });
  const flow = await beginFlow();
  // Google's own email casing is not guaranteed to match what the account
  // was created with; the route must fold both to lowercase to find it.
  profiles.set("code-existing-1", { email: "Existing@Example.Test", email_verified: true, name: null });
  const res = await finishFlow(flow, { code: "code-existing-1" });
  assert.equal(pathOf(res), "/account", "default destination with no next");
  const row = await db.execute({ sql: "SELECT * FROM account WHERE id = ?", args: ["existing-1"] });
  assert.equal(row.rows.length, 1, "no duplicate account created");
  assert.ok(row.rows[0].email_verified_at, "now marked verified via Google");
  assert.notEqual(row.rows[0].password_hash, "scrypt$aa$bb", "unverified credentials are removed");
  assert.equal(row.rows[0].google_subject, "existing@example.test");
});

await s.check("verified password accounts keep their password when linking Google", async () => {
  await db.execute({ sql: "INSERT INTO account(id,email,password_hash,created_at,email_verified_at) VALUES(?,?,?,?,?)",
    args: ["verified-password", "verified@example.test", "scrypt$aa$bb", new Date().toISOString(), new Date().toISOString()] });
  profiles.set("verified-code", { sub: "stable-verified-sub", email: "verified@example.test", email_verified: true });
  assert.ok(hasSessionCookie(await finishFlow(await beginFlow(), { code: "verified-code" })));
  const row = (await db.execute("SELECT * FROM account WHERE id='verified-password'")).rows[0];
  assert.equal(row.password_hash, "scrypt$aa$bb");
  assert.equal(row.google_subject, "stable-verified-sub");
});

await s.check("a different Google subject cannot inherit an already linked email", async () => {
  profiles.set("reassigned-code", { sub: "different-sub", email: "verified@example.test", email_verified: true });
  const res = await finishFlow(await beginFlow(), { code: "reassigned-code" });
  assert.equal(errorOf(res), "oauth");
  assert.equal(hasSessionCookie(res), false);
});

await s.check("the linked Google subject remains the identity when its email changes", async () => {
  profiles.set("changed-email-code", { sub: "stable-verified-sub", email: "new-verified@example.test", email_verified: true });
  assert.ok(hasSessionCookie(await finishFlow(await beginFlow(), { code: "changed-email-code" })));
  assert.equal((await db.execute("SELECT count(*) AS n FROM account WHERE email='new-verified@example.test'")).rows[0].n, 0);
});

await s.check("an unverified Google email is refused, not silently trusted", async () => {
  const flow = await beginFlow();
  profiles.set("code-unverified", { email: "unverified@example.test", email_verified: false, name: null });
  const res = await finishFlow(flow, { code: "code-unverified" });
  assert.equal(pathOf(res), "/login");
  assert.equal(errorOf(res), "oauth_unverified");
  assert.equal(hasSessionCookie(res), false, "no session for a rejected sign-in");
  const row = await db.execute({ sql: "SELECT * FROM account WHERE email = ?", args: ["unverified@example.test"] });
  assert.equal(row.rows.length, 0, "no account created from an unverified profile");
});

await s.check("Google reporting the visitor declined is a quiet cancel", async () => {
  const flow = await beginFlow();
  const res = await finishFlow(flow, { error: "access_denied" });
  assert.equal(pathOf(res), "/login");
  assert.equal(errorOf(res), "oauth_cancelled");
});

await s.check("a state that doesn't match the cookie is refused (CSRF)", async () => {
  const flow = await beginFlow();
  profiles.set("code-csrf", { email: "csrf@example.test", email_verified: true, name: null });
  const res = await finishFlow({ state: "not-the-real-state:", jar: flow.jar }, { code: "code-csrf" });
  assert.equal(errorOf(res), "oauth");
  const row = await db.execute({ sql: "SELECT * FROM account WHERE email = ?", args: ["csrf@example.test"] });
  assert.equal(row.rows.length, 0, "a forged callback creates nothing");
});

await s.check("a callback with no flow-start cookie at all is refused", async () => {
  const res = await finishFlow({ state: "whatever:", jar: jar() }, { code: "code-new-1" }, { withCookie: false });
  assert.equal(errorOf(res), "oauth");
});

await s.check("a code the fake Google doesn't recognise fails closed", async () => {
  const flow = await beginFlow();
  const res = await finishFlow(flow, { code: "no-such-code" });
  assert.equal(errorOf(res), "oauth");
});

await s.check("the state cookie is single-use", async () => {
  const flow = await beginFlow();
  profiles.set("code-reuse", { email: "reuse@example.test", email_verified: true, name: null });
  const first = await finishFlow(flow, { code: "code-reuse" });
  assert.ok(isRedirect(first));
  assert.equal(hasSessionCookie(first), true);
  profiles.set("code-reuse-2", { email: "reuse2@example.test", email_verified: true, name: null });
  // Same state, but the cookie that proved it was already deleted on the
  // first callback — replaying the link must not work a second time.
  const second = await finishFlow(flow, { code: "code-reuse-2" });
  assert.equal(errorOf(second), "oauth");
});

await s.check("without GOOGLE_CLIENT_ID/SECRET the feature does not exist", async () => {
  const off = await startApp({
    port: PORT + 1,
    env: { SITE_URL: `http://127.0.0.1:${PORT + 1}` },
  });
  try {
    const res = await fetch(`${off.base}/api/auth/google`, { redirect: "manual" });
    assert.equal(res.status, 404);
    const page = await (await fetch(`${off.base}/login`)).text();
    assert.ok(!page.includes("Continue with Google"), "no button rendered when unconfigured");
  } finally {
    await off.stop();
  }
});

await s.check("the login and signup pages offer Google when it is configured", async () => {
  for (const path of ["/login", "/signup"]) {
    const page = await (await fetch(`${app.base}${path}`)).text();
    assert.ok(page.includes("Continue with Google"), `${path} shows the button`);
    assert.ok(page.includes("/api/auth/google"), `${path} links to the start route`);
  }
});

await s.check("an OAuth error on /login renders as a readable notice", async () => {
  const page = await (await fetch(`${app.base}/login?error=oauth_unverified`)).text();
  assert.ok(page.includes("isn't verified"), "the mapped message is shown, not the raw code");
});

await google.close();
await app.stop();
db.close();
process.exit(s.finish());
