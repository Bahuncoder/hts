import crypto from "node:crypto";
import { db } from "./store";

/** Single-use, expiring tokens for password reset and email verification.
 *
 *  Only a SHA-256 of the token is stored. The plaintext exists once, in the
 *  email; a leaked database therefore yields no working links. Lookup is by
 *  hash, so there is nothing to compare in variable time.
 */

export type TokenKind = "password_reset" | "email_verify";

const TTL_MINUTES: Record<TokenKind, number> = {
  // Short: a reset link is a live credential sitting in an inbox.
  password_reset: 60,
  // Longer: someone may not open their mail until tomorrow.
  email_verify: 60 * 24 * 3,
};

const hash = (token: string) =>
  crypto.createHash("sha256").update(token).digest("hex");

export async function issue(
  kind: TokenKind,
  opts: { accountId?: string | null; email?: string | null; payload?: string },
): Promise<string> {
  const token = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  const c = await db();

  // A new token supersedes any outstanding one of the same kind, so a
  // forwarded older email cannot still be used.
  if (opts.accountId) {
    await c.execute({
      sql: "DELETE FROM auth_token WHERE kind = ? AND account_id = ? AND used_at IS NULL",
      args: [kind, opts.accountId],
    });
  } else if (opts.email) {
    await c.execute({
      sql: "DELETE FROM auth_token WHERE kind = ? AND email = ? AND used_at IS NULL",
      args: [kind, opts.email.toLowerCase()],
    });
  }

  await c.execute({
    sql: `INSERT INTO auth_token(token_hash, kind, account_id, email, payload, expires_at, created_at)
          VALUES(?,?,?,?,?,?,?)`,
    args: [
      hash(token), kind, opts.accountId ?? null,
      opts.email ? opts.email.toLowerCase() : null,
      opts.payload ?? null,
      new Date(now + TTL_MINUTES[kind] * 60_000).toISOString(),
      new Date(now).toISOString(),
    ],
  });
  return token;
}

export type ConsumedToken = {
  accountId: string | null; email: string | null; payload: string | null;
};

/** Validates and burns a token. Returns null for anything not currently
 *  usable — unknown, expired or already used — without distinguishing them. */
export async function consume(kind: TokenKind, token: string): Promise<ConsumedToken | null> {
  if (!token) return null;
  const c = await db();
  const rs = await c.execute({
    sql: "SELECT token_hash, account_id, email, payload, expires_at, used_at FROM auth_token WHERE token_hash = ? AND kind = ?",
    args: [hash(token), kind],
  });
  const row = rs.rows[0] as unknown as {
    token_hash: string; account_id: string | null; email: string | null;
    payload: string | null; expires_at: string; used_at: string | null;
  } | undefined;

  if (!row || row.used_at) return null;
  if (new Date(row.expires_at) < new Date()) return null;

  const upd = await c.execute({
    sql: "UPDATE auth_token SET used_at = ? WHERE token_hash = ? AND used_at IS NULL",
    args: [new Date().toISOString(), row.token_hash],
  });
  // Lost the race against a concurrent use of the same link.
  if (upd.rowsAffected === 0) return null;

  return { accountId: row.account_id, email: row.email, payload: row.payload };
}

/** Reads a token without burning it, to render a form before submission. */
export async function peek(kind: TokenKind, token: string): Promise<boolean> {
  if (!token) return false;
  const rs = await (await db()).execute({
    sql: "SELECT expires_at, used_at FROM auth_token WHERE token_hash = ? AND kind = ?",
    args: [hash(token), kind],
  });
  const row = rs.rows[0] as unknown as { expires_at: string; used_at: string | null } | undefined;
  return Boolean(row && !row.used_at && new Date(row.expires_at) >= new Date());
}

export async function purgeExpired(): Promise<number> {
  const rs = await (await db()).execute({
    sql: "DELETE FROM auth_token WHERE expires_at < ?",
    args: [new Date().toISOString()],
  });
  return rs.rowsAffected;
}
