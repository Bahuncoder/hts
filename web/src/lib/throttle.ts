import { headers } from "next/headers";
import { db } from "./store";
import { reserveAttempts, AUTH_LIMITS, attemptCutoff as cutoff } from "./attempts";

/** Throttle for credential endpoints.
 *
 *  Counted in the database, not process memory. An in-process counter is
 *  multiplied by the worker count — two workers give an attacker twice the
 *  configured budget — and is lost on every deploy.
 *
 *  Attempts are reserved before credential or mail work begins. This prevents
 *  concurrent guesses from all passing a check before failures are recorded.
 *  A genuine sign-in clears the email bucket; the client request budget stays.
 */

const WINDOW_MINUTES = AUTH_LIMITS.windowMinutes;

// The per-email limit is what actually stops guessing at one account.
const PER_EMAIL = AUTH_LIMITS.perEmail;
// Deliberately generous: a whole office shares one address behind NAT. This
// only needs to catch spraying across many accounts.
const PER_CLIENT = AUTH_LIMITS.perClient;

export async function clientId(): Promise<string> {
  const h = await headers();
  // Only trust the forwarded header when a proxy is declared: it is
  // caller-supplied, so trusting it unconditionally lets anyone reset their
  // own budget by forging it.
  if (process.env.HTSDESK_BEHIND_PROXY === "1") {
    const fwd = h.get("x-forwarded-for");
    if (fwd) return fwd.split(",").pop()!.trim();
  }
  return "local";
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

/** Atomically reserves both buckets BEFORE work. Returns minutes to wait. */
export async function checkThrottle(scope: string, email: string): Promise<number | null> {
  await sweep();
  const client = await clientId();
  const reserved = await reserveAttempts(scope, email, client);
  if (reserved) return null;
  return (await overBy(scope, `email:${email.toLowerCase()}`, PER_EMAIL))
      ?? (await overBy(scope, `client:${client}`, PER_CLIENT)) ?? 1;
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
