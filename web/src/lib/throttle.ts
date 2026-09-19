import { headers } from "next/headers";
import { db } from "./store";

/** Throttle for credential endpoints.
 *
 *  Counted in the database, not process memory. An in-process counter is
 *  multiplied by the worker count — two workers give an attacker twice the
 *  configured budget — and is lost on every deploy.
 *
 *  Only FAILURES are recorded. An earlier version charged successful sign-ins
 *  too, which meant an office behind one NAT address could lock itself out on
 *  a busy morning: a denial of service against paying customers dressed up as
 *  a security control. Counting is per email *and* per client because either
 *  alone is sidestepped by rotating the other.
 */

const WINDOW_MINUTES = 15;

// The per-email limit is what actually stops guessing at one account.
const PER_EMAIL = 8;
// Deliberately generous: a whole office shares one address behind NAT. This
// only needs to catch spraying across many accounts.
const PER_CLIENT = 60;

function cutoff(): string {
  return new Date(Date.now() - WINDOW_MINUTES * 60_000).toISOString();
}

export async function clientId(): Promise<string> {
  const h = await headers();
  // Only trust the forwarded header when a proxy is declared: it is
  // caller-supplied, so trusting it unconditionally lets anyone reset their
  // own budget by forging it.
  if (process.env.HTSDESK_BEHIND_PROXY === "1") {
    const fwd = h.get("x-forwarded-for");
    if (fwd) return fwd.split(",").pop()!.trim();
  }
  return h.get("x-real-ip") ?? "local";
}

async function overBy(scope: string, subject: string, limit: number): Promise<number | null> {
  const since = cutoff();
  const rs = await (await db()).execute({
    sql: "SELECT at FROM auth_attempt WHERE scope = ? AND subject = ? AND at >= ? ORDER BY at",
    args: [scope, subject, since],
  });
  const rows = rs.rows as unknown as { at: string }[];
  if (rows.length < limit) return null;
  const oldest = new Date(rows[0].at).getTime();
  const waitMs = oldest + WINDOW_MINUTES * 60_000 - Date.now();
  return Math.max(1, Math.ceil(waitMs / 60_000));
}

/** Checked BEFORE authenticating. Returns minutes to wait when over. */
export async function checkThrottle(scope: string, email: string): Promise<number | null> {
  await sweep();
  const client = await clientId();
  return (await overBy(scope, `email:${email.toLowerCase()}`, PER_EMAIL))
      ?? (await overBy(scope, `client:${client}`, PER_CLIENT));
}

/** Called only when an attempt FAILED. A success costs the caller nothing. */
export async function recordFailure(scope: string, email: string): Promise<void> {
  const now = new Date().toISOString();
  const client = await clientId();
  const c = await db();
  await c.execute({
    sql: "INSERT INTO auth_attempt(scope, subject, at) VALUES(?, ?, ?)",
    args: [scope, `email:${email.toLowerCase()}`, now],
  });
  await c.execute({
    sql: "INSERT INTO auth_attempt(scope, subject, at) VALUES(?, ?, ?)",
    args: [scope, `client:${client}`, now],
  });
}

/** Clears an email's failures after a genuine sign-in, so someone mistyping
 *  once does not carry a penalty into the rest of the day. */
export async function clearAttempts(scope: string, email: string): Promise<void> {
  await (await db()).execute({
    sql: "DELETE FROM auth_attempt WHERE scope = ? AND subject = ?",
    args: [scope, `email:${email.toLowerCase()}`],
  });
}

let lastSweep = 0;

/** Drops rows outside the window. Cheap, and keeps the table from growing
 *  without bound on a busy instance. */
async function sweep(): Promise<void> {
  const now = Date.now();
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  await (await db()).execute({ sql: "DELETE FROM auth_attempt WHERE at < ?", args: [cutoff()] });
}
