import crypto from "node:crypto";
import { db } from "./store";

/** Work budgets for the public proxies.
 *
 *  The proxy attaches the engine key, which the engine's own rate limiter
 *  exempts, so this is the only place a caller's volume can be bounded before
 *  it becomes engine CPU. Counted in the database, like the credential
 *  throttle, so the limit holds across workers and deploys.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

type Limit = { max: number; windowMs: number };
export type Tier = "anonymous" | "free" | "starter" | "growth";

/** `requests` bounds how often a caller may start an audit, `items` how much
 *  work they may submit in total. Paid tiers are bounded by items alone. */
export const AUDIT_BUDGETS: Record<Tier, { requests?: Limit; items: Limit }> = {
  anonymous: { requests: { max: 3, windowMs: 10 * MINUTE }, items: { max: 150, windowMs: DAY } },
  free: { requests: { max: 10, windowMs: HOUR }, items: { max: 500, windowMs: DAY } },
  starter: { items: { max: 3000, windowMs: DAY } },
  growth: { items: { max: 20000, windowMs: DAY } },
};

export const AUDIT_LEASE_MS = 60_000;

/** Server-rendered classification, per client. */
export const CLASSIFY_LIMIT: Limit = { max: 30, windowMs: MINUTE };

const REQUESTS = "audit_requests";
const ITEMS = "audit_items";

/** Seconds until `cost` more work fits inside `limit`, or 0 if it fits now.
 *  Infinity when `cost` alone exceeds the whole allowance. */
async function waitFor(scope: string, subject: string, limit: Limit, cost: number): Promise<number> {
  if (cost > limit.max) return Infinity;
  const now = Date.now();
  const rs = await (await db()).execute({
    sql: "SELECT at, cost FROM usage_event WHERE scope = ? AND subject = ? AND at >= ? ORDER BY at",
    args: [scope, subject, new Date(now - limit.windowMs).toISOString()],
  });
  let used = 0;
  for (const r of rs.rows as unknown as { at: string; cost: number }[]) used += r.cost;
  if (used + cost <= limit.max) return 0;
  for (const r of rs.rows as unknown as { at: string; cost: number }[]) {
    used -= r.cost;
    if (used + cost <= limit.max) {
      return Math.max(1, Math.ceil((new Date(r.at).getTime() + limit.windowMs - now) / 1000));
    }
  }
  return Math.ceil(limit.windowMs / 1000);
}

async function record(scope: string, subject: string, at: string, cost: number) {
  await (await db()).execute({
    sql: "INSERT INTO usage_event(scope, subject, at, cost) VALUES(?,?,?,?)",
    args: [scope, subject, at, cost],
  });
}

export type Charge =
  | { ok: true; refund: () => Promise<void> }
  | { ok: false; retryAfter: number; over: "requests" | "items"; tooLarge: boolean };

/** Checks both budgets and, if the call fits, charges it: one request and
 *  `items` items. A refused call is not charged. Call while holding the
 *  subject's lease so two calls cannot both pass the check. */
export async function chargeAudit(subject: string, tier: Tier, items: number): Promise<Charge> {
  await sweep();
  const budget = AUDIT_BUDGETS[tier];
  const requestWait = budget.requests ? await waitFor(REQUESTS, subject, budget.requests, 1) : 0;
  const itemWait = await waitFor(ITEMS, subject, budget.items, items);
  if (requestWait || itemWait) {
    const over = itemWait >= requestWait && itemWait ? "items" : "requests";
    const wait = Math.max(requestWait, itemWait);
    return { ok: false, over, tooLarge: !Number.isFinite(wait),
             retryAfter: Number.isFinite(wait) ? wait : Math.ceil(budget.items.windowMs / 1000) };
  }
  const at = new Date().toISOString();
  await record(REQUESTS, subject, at, 1);
  await record(ITEMS, subject, at, items);
  return {
    ok: true,
    refund: async () => {
      await (await db()).execute({
        sql: "DELETE FROM usage_event WHERE subject = ? AND at = ? AND scope IN (?, ?)",
        args: [subject, at, REQUESTS, ITEMS],
      });
    },
  };
}

/** Records one hit and returns null, or returns seconds to wait when the
 *  caller is over `limit`. Refused hits are not recorded. */
export async function allow(scope: string, subject: string, limit: Limit): Promise<number | null> {
  await sweep();
  const wait = await waitFor(scope, subject, limit, 1);
  if (wait) return wait;
  await record(scope, subject, new Date().toISOString(), 1);
  return null;
}

/** One in-flight audit per subject. Returns a release function, or null when
 *  another audit holds the lease. The expiry frees a lease whose holder died. */
export async function acquireLease(subject: string, ttlMs = AUDIT_LEASE_MS): Promise<(() => Promise<void>) | null> {
  const c = await db();
  const token = crypto.randomUUID();
  const now = new Date();
  const res = await c.execute({
    sql: `INSERT INTO usage_lease(subject, token, expires_at) VALUES(?,?,?)
          ON CONFLICT(subject) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at
          WHERE usage_lease.expires_at < ?`,
    args: [subject, token, new Date(now.getTime() + ttlMs).toISOString(), now.toISOString()],
  });
  if (!res.rowsAffected) return null;
  return async () => {
    await c.execute({ sql: "DELETE FROM usage_lease WHERE subject = ? AND token = ?", args: [subject, token] });
  };
}

let lastSweep = 0;

/** Drops events older than the longest window and expired leases. */
async function sweep(): Promise<void> {
  const now = Date.now();
  if (now - lastSweep < MINUTE) return;
  lastSweep = now;
  const c = await db();
  await c.execute({ sql: "DELETE FROM usage_event WHERE at < ?", args: [new Date(now - DAY).toISOString()] });
  await c.execute({ sql: "DELETE FROM usage_lease WHERE expires_at < ?", args: [new Date(now).toISOString()] });
}
