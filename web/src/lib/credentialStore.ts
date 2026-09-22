import crypto from "node:crypto";
import { db } from "./store";

/** The password snapshot is checked by the INSERT itself. A reset either
 * deletes an earlier session or makes a later stale login fail this predicate. */
export async function insertSession(accountId: string, expectedHash: string, token: string, expiresAt: string): Promise<boolean> {
  const result = await (await db()).execute({
    sql: "INSERT INTO session(token,account_id,expires_at) SELECT ?,id,? FROM account WHERE id = ? AND password_hash = ?",
    args: [token, expiresAt, accountId, expectedHash],
  });
  return result.rowsAffected === 1;
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
