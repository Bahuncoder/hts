import crypto from "node:crypto";
import {
  apiKeyByHash, apiKeysForAccount, insertApiKey, revokeApiKeyRow, touchApiKeyLastUsed,
  type ApiKey,
} from "./store";

/** B2B API key issuance and verification.
 *
 *  Deliberately does not import from auth.ts: this file (like store.ts) has no
 *  Next.js-runtime dependency, so it can be loaded directly by the lightweight
 *  test harness (tsload.mjs) without pulling in next/headers.
 *
 *  Unlike a user password (auth.ts's scrypt, deliberately slow to resist an
 *  offline dictionary attack on a human-chosen secret), a key's secret is
 *  144 bits of random data -- there is no dictionary to defend against, and a
 *  fast hash keeps every API request's auth check cheap. This matches the
 *  codebase's existing precedent for a high-entropy bearer secret:
 *  credentialStore.ts's password-reset token is hashed the same way, with no
 *  pepper. */
const PREFIX_LEN = 12;

export function generateApiKeySecret(): string {
  return `htsd_${crypto.randomBytes(24).toString("base64url")}`;
}

export function hashApiKeySecret(secret: string): string {
  return crypto.createHash("sha256").update(secret).digest("hex");
}

export type CreatedApiKey = { id: string; secret: string; prefix: string };

export class ApiKeyLimitError extends Error {}

/** Returns the raw secret -- shown to the caller exactly once. It is never
 *  stored and cannot be recovered afterward. */
export async function createApiKey(accountId: string, name: string, maxKeys = 10): Promise<CreatedApiKey> {
  const secret = generateApiKeySecret();
  const id = crypto.randomUUID();
  const inserted = await insertApiKey({
    id, account_id: accountId, name, prefix: secret.slice(0, PREFIX_LEN),
    hash: hashApiKeySecret(secret), created_at: new Date().toISOString(),
  }, maxKeys);
  if (!inserted) throw new ApiKeyLimitError(`You have reached the maximum of ${maxKeys} keys. Revoke one before creating another.`);
  return { id, secret, prefix: secret.slice(0, PREFIX_LEN) };
}

/** Verifies a bearer secret against the stored hash. A revoked key is treated
 *  the same as an unknown one -- both return null. Touches last_used_at,
 *  best-effort and coarse (store.ts only writes if it is stale). */
export async function verifyApiKey(secret: string): Promise<ApiKey | null> {
  const key = await apiKeyByHash(hashApiKeySecret(secret));
  if (!key || key.revoked_at) return null;
  await touchApiKeyLastUsed(key.id, key.last_used_at);
  return key;
}

export async function listApiKeys(accountId: string): Promise<ApiKey[]> {
  return apiKeysForAccount(accountId);
}

/** Returns whether a key was actually revoked (false if it did not exist, was
 *  already revoked, or belongs to another account). */
export async function revokeApiKeyForAccount(accountId: string, id: string): Promise<boolean> {
  return revokeApiKeyRow(accountId, id);
}
