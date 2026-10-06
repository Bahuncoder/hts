import crypto from "node:crypto";
import { db } from "./store";

/** The database stores only a digest; the browser keeps the random secret. */
export function sessionTokenHash(token: string): string {
  return `sha256:${crypto.createHash("sha256").update(token).digest("hex")}`;
}

/** The password snapshot is checked by the INSERT itself. A reset either
 * deletes an earlier session or makes a later stale login fail this predicate. */
export async function insertSession(accountId: string, expectedHash: string, token: string, expiresAt: string): Promise<boolean> {
  const result = await (await db()).execute({
    sql: "INSERT INTO session(token,account_id,expires_at) SELECT ?,id,? FROM account WHERE id = ? AND password_hash = ?",
    args: [sessionTokenHash(token), expiresAt, accountId, expectedHash],
  });
  return result.rowsAffected === 1;
}

/** Verified Google ownership may reclaim an unverified legacy account.
 * Credential replacement, identity binding and revocations commit together.
 * Verified password accounts retain their password when first linked. */
export async function linkGoogleCredential(accountId: string, expectedHash: string,
                                           subject: string, replacementHash: string): Promise<string | null> {
  const eligible = "SELECT id FROM account WHERE id = ? AND password_hash = ? AND email_verified_at IS NULL AND (google_subject IS NULL OR google_subject = ?)";
  const args = [accountId, expectedHash, subject];
  const results = await (await db()).batch([
    { sql: `DELETE FROM session WHERE account_id IN (${eligible})`, args },
    { sql: `UPDATE api_key SET revoked_at = ? WHERE account_id IN (${eligible}) AND revoked_at IS NULL`,
      args: [new Date().toISOString(), ...args] },
    { sql: `DELETE FROM auth_token WHERE account_id IN (${eligible})`, args },
    { sql: `UPDATE account SET password_hash = CASE WHEN email_verified_at IS NULL THEN ? ELSE password_hash END,
             email_verified_at = coalesce(email_verified_at, ?), google_subject = ?
            WHERE id = ? AND password_hash = ? AND (google_subject IS NULL OR google_subject = ?)
            RETURNING password_hash`,
      args: [replacementHash, new Date().toISOString(), subject, ...args] },
  ], "write");
  return results[3].rows[0]?.password_hash as string ?? null;
}

/** Token validation, password replacement, session revocation and revocation
 * of sibling reset tokens commit together, including under concurrent resets. */
export async function resetCredential(token: string, passwordHash: string): Promise<string | null> {
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  const now = new Date().toISOString();
  const eligible = "SELECT account_id FROM auth_token WHERE token_hash = ? AND kind = 'password_reset' AND used_at IS NULL AND expires_at > ?";
  const results = await (await db()).batch([
    { sql: `UPDATE account SET password_hash = ? WHERE id IN (${eligible}) RETURNING id`, args: [passwordHash, hash, now] },
    { sql: `DELETE FROM session WHERE account_id IN (${eligible})`, args: [hash, now] },
    { sql: `DELETE FROM auth_token WHERE account_id IN (${eligible}) AND kind = 'password_reset'`, args: [hash, now] },
  ], "write");
  return results[0].rows[0]?.id as string ?? null;
}
