/** Concurrency, not just sequence: fires genuinely simultaneous calls at the
 *  three race-prone primitives auth-transaction.test.mjs only exercises one
 *  at a time (reserveAttempts, token consume, credential reset), and checks
 *  the atomic-SQL claims in their own comments actually hold — that exactly
 *  one caller wins, not "whichever happened to go first in this run".
 *
 *  Pure lib functions against a scratch embedded libSQL file (never
 *  data/accounts.db) — no server, no browser.
 *
 *  Run: node tests/auth-races.test.mjs
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { scratchDir, suite } from "./harness.mjs";
import { loadLib } from "./tsload.mjs";

process.env.HTSDESK_ACCOUNTS_DB = path.join(scratchDir("htsdesk-race-"), "accounts.db");
delete process.env.TURSO_DATABASE_URL;

const { db } = await loadLib("store");
const { reserveAttempts, AUTH_LIMITS } = await loadLib("attempts");
const { issue, consume } = await loadLib("tokens");
const { insertSession, resetCredential } = await loadLib("credentialStore");

const c = await db();
const s = suite();

// Every serverless invocation in production opens its own connection to
// Turso; racing promises on one shared client object (as `db()` above
// returns, cached) interleaves at the JS event-loop level, but never proves
// the SQL itself is safe against two genuinely separate connections hitting
// the same row at once. The two checks that matter most for money and
// account takeover — token redemption and a credential reset — are run
// again here across N independent connections to the same file, which is
// the actual shape of the thing being defended against.

const scrypt = (pw, salt) => `scrypt$${salt.toString("hex")}$${crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 }).toString("hex")}`;

async function seedAccount(id, email, password) {
  const salt = crypto.randomBytes(16);
  const hash = scrypt(password, salt);
  await c.execute({ sql: "INSERT INTO account(id,email,password_hash,created_at) VALUES(?,?,?,?)", args: [id, email, hash, new Date().toISOString()] });
  return hash;
}

await s.check("reserveAttempts: N simultaneous callers for one email never over-admit the per-email budget", async () => {
  await seedAccount("race-throttle", "throttle@example.test", "whatever-password-1");
  const email = "throttle-race@example.test"; // budget is per email, account need not exist
  const client = "203.0.113.5";
  // Fire well past the limit (8) all at once — not one at a time.
  const N = AUTH_LIMITS.perEmail * 3;
  const results = await Promise.all(Array.from({ length: N }, () => reserveAttempts("login", email, client)));
  const admitted = results.filter(Boolean).length;
  assert.equal(admitted, AUTH_LIMITS.perEmail,
    `admitted ${admitted} of ${N} concurrent attempts; the per-email budget of ${AUTH_LIMITS.perEmail} was not enforced atomically`);
});

await s.check("reserveAttempts: the per-client budget is likewise enforced under true concurrency, across many emails", async () => {
  const client = "203.0.113.9";
  const N = AUTH_LIMITS.perClient * 2;
  const results = await Promise.all(Array.from({ length: N }, (_, i) => reserveAttempts("login", `spray-${i}@example.test`, client)));
  const admitted = results.filter(Boolean).length;
  assert.equal(admitted, AUTH_LIMITS.perClient,
    `admitted ${admitted} of ${N}; the per-client budget of ${AUTH_LIMITS.perClient} was not enforced atomically`);
});

await s.check("token consume: N simultaneous redemptions of the same link, exactly one succeeds", async () => {
  await seedAccount("race-token", "token-race@example.test", "whatever-password-2");
  const token = await issue("password_reset", { accountId: "race-token", email: "token-race@example.test" });
  const N = 20;
  const results = await Promise.all(Array.from({ length: N }, () => consume("password_reset", token)));
  const won = results.filter((r) => r !== null);
  assert.equal(won.length, 1, `${won.length} of ${N} concurrent redemptions of the same token succeeded; a reset link must be usable exactly once`);
  assert.equal(won[0].accountId, "race-token");
});

await s.check("token issue: a fresh token supersedes an outstanding one even mid-flight, never leaving two live tokens", async () => {
  await seedAccount("race-supersede", "supersede@example.test", "whatever-password-3");
  const [a, b] = await Promise.all([
    issue("password_reset", { accountId: "race-supersede" }),
    issue("password_reset", { accountId: "race-supersede" }),
  ]);
  const results = await Promise.all([a, b].map((t) => consume("password_reset", t)));
  const won = results.filter((r) => r !== null);
  assert.ok(won.length <= 1, `${won.length} of 2 superseding tokens both redeemed — two live reset links for one account`);
});

await s.check("resetCredential: N simultaneous submissions of the same reset token, exactly one takes effect", async () => {
  const oldHash = await seedAccount("race-reset", "reset-race@example.test", "old-passphrase-value");
  const token = await issue("password_reset", { accountId: "race-reset" });
  const N = 15;
  const newHashes = Array.from({ length: N }, (_, i) => `scrypt$aa$candidate-${i}`);
  const results = await Promise.all(newHashes.map((h) => resetCredential(token, h)));
  const won = results.filter((r) => r !== null);
  assert.equal(won.length, 1, `${won.length} of ${N} concurrent resets with the same token succeeded`);
  const row = await c.execute({ sql: "SELECT password_hash FROM account WHERE id = ?", args: ["race-reset"] });
  const finalHash = row.rows[0].password_hash;
  assert.notEqual(finalHash, oldHash, "the password never actually changed");
  assert.ok(newHashes.includes(finalHash), "the account's password is not one of the candidates that raced for it");
});

await s.check("resetCredential: a session insert racing the reset it is stale against never wins", async () => {
  const oldHash = await seedAccount("race-session", "session-race@example.test", "old-passphrase-value-2");
  const token = await issue("password_reset", { accountId: "race-session" });
  // Simulate an in-flight login (started before the reset, committing after
  // it) racing the reset itself — both hit the database at the same instant.
  const [sessionOk, resetResult] = await Promise.all([
    insertSession("race-session", oldHash, crypto.randomBytes(16).toString("hex"), new Date(Date.now() + 60_000).toISOString()),
    resetCredential(token, "scrypt$new$aftermath"),
  ]);
  assert.ok(resetResult, "the reset itself must still succeed alongside the racing login");
  // Whichever order the two statements actually land in, a session must
  // never end up valid for a password that is no longer current: either the
  // insert was rejected outright, or it succeeded and was then revoked by
  // the reset's own session wipe.
  const sessions = await c.execute({ sql: "SELECT count(*) AS n FROM session WHERE account_id = ?", args: ["race-session"] });
  assert.equal(Number(sessions.rows[0].n), 0, "a session survived a concurrent password reset");
  void sessionOk;
});

await s.check("token consume across N independent connections (not one shared client): still exactly one winner", async () => {
  await seedAccount("race-conn-token", "conn-token@example.test", "whatever-password-4");
  const token = await issue("password_reset", { accountId: "race-conn-token", email: "conn-token@example.test" });
  const N = 8;
  const instances = await Promise.all(Array.from({ length: N }, () => loadLib("tokens", { fresh: true })));
  const results = await Promise.all(instances.map((mod) => mod.consume("password_reset", token)));
  const won = results.filter((r) => r !== null);
  assert.equal(won.length, 1, `${won.length} of ${N} independent connections redeemed the same token`);
});

await s.check("credential reset across N independent connections: still exactly one winner", async () => {
  await seedAccount("race-conn-reset", "conn-reset@example.test", "whatever-password-5");
  const token = await issue("password_reset", { accountId: "race-conn-reset" });
  const N = 8;
  const instances = await Promise.all(Array.from({ length: N }, () => loadLib("credentialStore", { fresh: true })));
  const results = await Promise.all(instances.map((mod, i) => mod.resetCredential(token, `scrypt$bb$conn-candidate-${i}`)));
  const won = results.filter((r) => r !== null);
  assert.equal(won.length, 1, `${won.length} of ${N} independent connections completed the same reset`);
});

process.exit(s.finish());
