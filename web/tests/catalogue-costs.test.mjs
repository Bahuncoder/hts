import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import ts from "typescript";
const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "catalogue-costs-"));
process.env.HTSDESK_ACCOUNTS_DB = path.join(scratch, "accounts.db");
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;
fs.symlinkSync(path.join(web, "node_modules"), path.join(scratch, "node_modules"), "dir");
const emitted = new Set();
function emit(name) {
  if (emitted.has(name)) return;
  emitted.add(name);
  const source = fs.readFileSync(path.join(web, "src/lib", name + ".ts"), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace(/from "\.\/([\w-]+)"/g, (_, dep) => { emit(dep); return `from "./${dep}.mjs"`; });
  fs.writeFileSync(path.join(scratch, name + ".mjs"), js);
}
let client;
try {
  emit("catalogues");
  const store = await import(pathToFileURL(path.join(scratch, "store.mjs")));
  const cats = await import(pathToFileURL(path.join(scratch, "catalogues.mjs")));
  client = await store.db();
  await store.createAccount("owner", "owner@example.test", "fixture");
  await store.createAccount("other", "other@example.test", "fixture");
  const costs = { freight: 10.25, insurance: 2, brokerage: 3, portFees: 4, other: 5 };
  const audit = { v: 1, at: new Date().toISOString(), dataset_revision: "fixture", assumptions: ["fixture assumption"], mpf: 1, entries: 1, by_vessel: true, lines: [
    { row: 1, sku: "one", description: "Fixture", country: "China", hts: "1234.56.78", status: "ready", entered_value: 100, duty: 10, refundable: 0 },
    { row: 2, sku: "two", description: "Unresolved", country: "China", hts: null, status: "unclassified" },
  ] };
  const id = await cats.saveCatalogue("owner", "Fixture catalogue", audit, [100, 50], costs);
  const saved = await cats.getCatalogue("owner", id);
  assert.deepEqual(JSON.parse(saved.landed_cost_json), costs);
  assert.equal(saved.totals_complete, 0);
  assert.equal(saved.items.length, 2);
  assert.equal(await cats.getCatalogue("other", id), null);
  const defaultId = await cats.saveCatalogue("owner", "Default costs", audit);
  const defaults = await cats.getCatalogue("owner", defaultId);
  assert.equal(JSON.parse(defaults.landed_cost_json).freight, 0);
  await cats.watchCode("owner", "1234.56.78");
  await cats.watchCode("owner", "1234.56.78");
  assert.equal((await client.execute("SELECT count(*) n FROM watched_code WHERE catalogue_id IS NULL")).rows[0].n, 1);
  for (const mod of ["tokens", "credentialStore", "budget", "attempts", "reviews"]) emit(mod);
  const tokens = await import(pathToFileURL(path.join(scratch, "tokens.mjs")));
  const credentials = await import(pathToFileURL(path.join(scratch, "credentialStore.mjs")));
  const budget = await import(pathToFileURL(path.join(scratch, "budget.mjs")));
  const attempts = await import(pathToFileURL(path.join(scratch, "attempts.mjs")));
  const reviews = await import(pathToFileURL(path.join(scratch, "reviews.mjs")));
  const grants = await Promise.all(Array.from({ length: 30 }, () => budget.allow("classification", "fixture", { max: 5, windowMs: 60000 })));
  assert.equal(grants.filter((g) => g === null).length, 5, "classification budget cannot be oversubscribed");
  const guesses = await Promise.all(Array.from({ length: 20 }, () => attempts.reserveAttempts("login", "victim@example.test", "client")));
  assert.equal(guesses.filter(Boolean).length, attempts.AUTH_LIMITS.perEmail);
  assert.equal((await client.execute("SELECT count(*) n FROM auth_attempt WHERE scope = 'login' AND subject = 'client:client'")).rows[0].n, attempts.AUTH_LIMITS.perEmail);
  const spray = await Promise.all(Array.from({ length: 70 }, (_, i) => attempts.reserveAttempts("signup", `${i}@example.test`, "spray-client")));
  assert.equal(spray.filter(Boolean).length, attempts.AUTH_LIMITS.perClient, "successful new signups still consume client budget");

  const issued = await Promise.all(Array.from({ length: 6 }, () => tokens.issue("password_reset", { accountId: "owner", email: "owner@example.test" })));
  const alive = await Promise.all(issued.map((token) => tokens.peek("password_reset", token)));
  assert.equal(alive.filter(Boolean).length, 1, "supersession is atomic under concurrent requests");
  const token = issued[alive.indexOf(true)];
  assert.equal(await credentials.insertSession("owner", "fixture", "old-session", "2099-01-01T00:00:00.000Z"), true);
  await client.execute("CREATE TRIGGER reject_session_delete BEFORE DELETE ON session BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  await assert.rejects(credentials.resetCredential(token, "new-password"));
  assert.equal((await store.accountByEmail("owner@example.test")).password_hash, "fixture", "password update rolls back if revocation fails");
  assert.equal(await tokens.peek("password_reset", token), true);
  await client.execute("DROP TRIGGER reject_session_delete");
  const resets = await Promise.all([credentials.resetCredential(token, "new-password"), credentials.resetCredential(token, "other-password")]);
  assert.equal(resets.filter(Boolean).length, 1, "a reset link commits only once");
  assert.equal((await client.execute("SELECT count(*) n FROM session WHERE account_id = 'owner'")).rows[0].n, 0);
  assert.equal(await credentials.insertSession("owner", "fixture", "late-old-login", "2099-01-01T00:00:00.000Z"), false, "a login already holding the old hash cannot create a post-reset session");
  const currentHash = (await store.accountByEmail("owner@example.test")).password_hash;
  assert.equal(await credentials.insertSession("owner", currentHash, "fresh-login", "2099-01-01T00:00:00.000Z"), true);

  const item = saved.items[0];
  const review = { catalogueId: id, itemId: item.id, action: "approve", note: "Checked the product specification", version: 0 };
  assert.equal(await reviews.recordReview("other", "other@example.test", review), false);
  const approvals = await Promise.all([reviews.recordReview("owner", "owner@example.test", review), reviews.recordReview("owner", "owner@example.test", { ...review, action: "needs_review" })]);
  assert.equal(approvals.filter(Boolean).length, 1);
  let history = await reviews.listReviews("owner", id);
  assert.equal(history.length, 1);
  assert.equal(history[0].actor_email, "owner@example.test");
  assert.equal(await reviews.recordReview("owner", "owner@example.test", { ...review, action: "comment", note: "Comment without changing decision", version: 1 }), true);
  history = await reviews.listReviews("owner", id);
  assert.equal(history[1].status, history[0].status);
  assert.equal(await reviews.recordReview("owner", "owner@example.test", { ...review, action: "reopen", version: 2 }), true);
  assert.equal((await cats.getCatalogue("owner", id)).items[0].review_status, "pending");
  assert.equal(await reviews.recordReview("owner", "owner@example.test", { ...review, itemId: saved.items[1].id }), false, "unclassified lines cannot be approved");
  assert.deepEqual(await reviews.listReviews("other", id), []);
  console.log("Concurrent quota reservations, token supersession, reset rollback/replay, stale login rejection and review history checks passed.");
  console.log("Catalogue persistence, default costs, partial records, account isolation and watch deduplication passed.");
} finally {
  client?.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}
