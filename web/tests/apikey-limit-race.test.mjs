/** The API-key ceiling holds under concurrent creation (security audit S05).
 *
 *  insertApiKey writes a key only while the account is under its ceiling, in
 *  one statement, so concurrent requests cannot all see a free slot. Pure
 *  library calls against a scratch libSQL file (never data/accounts.db).
 *  Run: node tests/apikey-limit-race.test.mjs
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { scratchDir, suite } from "./harness.mjs";
import { loadLib } from "./tsload.mjs";

process.env.HTSDESK_ACCOUNTS_DB = path.join(scratchDir("htsdesk-apikey-race-"), "accounts.db");
delete process.env.TURSO_DATABASE_URL;

const { createAccount } = await loadLib("store");
const { createApiKey, ApiKeyLimitError } = await loadLib("apiKeys");
const { listApiKeys } = await loadLib("apiKeys");

const t = suite();

await t.check("eight concurrent key creations under a limit of two: exactly two succeed", async () => {
  const account = { id: crypto.randomUUID() };
  await createAccount(account.id, `keys-${Date.now()}@example.test`, "scrypt$0$0");
  const outcomes = await Promise.allSettled(
    Array.from({ length: 8 }, (_, i) => createApiKey(account.id, `key ${i}`, 2)),
  );
  const created = outcomes.filter((o) => o.status === "fulfilled").length;
  const refused = outcomes.filter((o) => o.status === "rejected" && o.reason instanceof ApiKeyLimitError).length;
  assert.equal(created, 2, `created ${created}`);
  assert.equal(refused, 6, `refused ${refused} with the limit error`);
  const active = (await listApiKeys(account.id)).filter((k) => !k.revoked_at).length;
  assert.equal(active, 2, `stored ${active}`);
});

await t.check("a revoked key frees its slot for a new one", async () => {
  const account = { id: crypto.randomUUID() };
  await createAccount(account.id, `revoke-${Date.now()}@example.test`, "scrypt$0$0");
  await createApiKey(account.id, "first", 1);
  await assert.rejects(createApiKey(account.id, "second", 1), ApiKeyLimitError);
  const [first] = await listApiKeys(account.id);
  const { revokeApiKeyForAccount } = await loadLib("apiKeys");
  await revokeApiKeyForAccount(account.id, first.id);
  await createApiKey(account.id, "third", 1);
  const active = (await listApiKeys(account.id)).filter((k) => !k.revoked_at).length;
  assert.equal(active, 1);
});

process.exit(t.finish());
