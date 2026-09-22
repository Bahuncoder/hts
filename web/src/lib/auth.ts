import crypto from "node:crypto";
import { cookies } from "next/headers";
import { accountById, accountByEmail, createAccount, db, type Account } from "./store";
import { LIMITS, type Limits } from "./plans";
import { insertSession } from "./credentialStore";

const COOKIE = "htsdesk_session";
const SESSION_DAYS = 30;

/** scrypt from the standard library — no password-hashing dependency to keep
 *  patched. Parameters are the Node defaults with a raised cost. */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

/** Exposed so a pending signup can carry an already-hashed password
 *  through a verification token without ever storing the plaintext. */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, keyHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !keyHex) return false;
  const key = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), SCRYPT.keylen, SCRYPT);
  const expected = Buffer.from(keyHex, "hex");
  // Constant-time: a length mismatch must not short-circuit the comparison.
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

export function validEmail(email: string): boolean {
  return /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email) && email.length <= 254;
}

const WEAK = ["password", "12345678", "qwerty", "letmein", "htsdesk", "iloveyou"];

/** Rejects the passwords that actually get accounts taken over, and nothing
 *  else: length is what matters, composition rules only push people to
 *  "Password1!".
 *
 *  A weak word is only disqualifying when it is most of the password. Plain
 *  substring matching rejected "a-long-enough-password", which is a perfectly
 *  good passphrase — and punishing long passphrases for containing a common
 *  word pushes people back towards short cryptic ones.
 */
export function passwordProblem(password: string): string | null {
  if (password.length < 10) return "Use at least 10 characters.";
  if (password.length > 200) return "That password is too long.";

  const normalised = password.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const weak of WEAK) {
    const remainder = normalised.split(weak).join("");
    if (remainder.length < 6) return "That password is too easy to guess.";
  }
  if (/^(.)\1+$/.test(normalised)) return "That password is too easy to guess.";
  return null;
}

export async function signUp(email: string, password: string,
                             opts: { verified?: boolean } = {}): Promise<{ id: string; passwordHash: string }> {
  const id = crypto.randomUUID();
  const passwordHash = hashPassword(password);
  await createAccount(id, email.trim().toLowerCase(), passwordHash);
  if (opts.verified) {
    await (await db()).execute({
      sql: "UPDATE account SET email_verified_at = ? WHERE id = ?",
      args: [new Date().toISOString(), id],
    });
  }
  return { id, passwordHash };
}

export async function markEmailVerified(accountId: string): Promise<void> {
  await (await db()).execute({
    sql: "UPDATE account SET email_verified_at = ? WHERE id = ?",
    args: [new Date().toISOString(), accountId],
  });
}

export async function authenticate(email: string, password: string): Promise<{ id: string; passwordHash: string } | null> {
  const acct = await accountByEmail(email.trim().toLowerCase());
  if (!acct) {
    // Hash anyway so a missing account is not detectably faster than a wrong
    // password — otherwise timing enumerates registered emails.
    hashPassword(password);
    return null;
  }
  return verifyPassword(password, acct.password_hash) ? { id: acct.id, passwordHash: acct.password_hash } : null;
}

export async function startSession(accountId: string, expectedHash: string): Promise<boolean> {
  const token = crypto.randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5);
  if (!await insertSession(accountId, expectedHash, token, expires.toISOString())) return false;
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires,
  });
  return true;
}

export async function endSession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (token) {
    await (await db()).execute({ sql: "DELETE FROM session WHERE token = ?", args: [token] });
  }
  jar.delete(COOKIE);
}

/** A signed-in account and the limits that apply to it. */
export type Viewer = { account: Account; limits: Limits };

export async function currentViewer(): Promise<Viewer | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  const c = await db();
  const rs = await c.execute({
    sql: "SELECT account_id, expires_at FROM session WHERE token = ?",
    args: [token],
  });
  const row = rs.rows[0] as unknown as { account_id: string; expires_at: string } | undefined;
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) {
    await c.execute({ sql: "DELETE FROM session WHERE token = ?", args: [token] });
    return null;
  }
  const account = await accountById(row.account_id);
  if (!account) return null;
  return { account, limits: LIMITS.account };
}
