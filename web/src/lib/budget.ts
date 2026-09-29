import crypto from "node:crypto";
import { db } from "./store";
import type { Window } from "./plans";

/** Work budgets for the public proxies.
 *
 *  The proxy attaches the engine key, which the engine's own rate limiter
 *  exempts, so this is the only place a caller's volume can be bounded before
 *  it becomes engine CPU. Counted in the database, like the credential
 *  throttle, so the limit holds across workers and deploys.
 */

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

type Limit = Window;

export type AuditBudget = { requests: Limit; items: Limit };

export const AUDIT_LEASE_MS = 60_000;

/** Server-rendered classification, per client. */
export const CLASSIFY_LIMIT: Limit = { max: 30, windowMs: MINUTE };

const REQUESTS = "audit_requests";
const ITEMS = "audit_items";

// A separate scope, not a parameter on chargeAudit: an account's programmatic
// API usage and its interactive web-UI usage are metered independently, so a
// customer's automated integration cannot exhaust (or be exhausted by) their
// own team's manual web usage. Kept as a sibling function rather than
// generalising chargeAudit's signature, to avoid touching its two already-
// stable, tested call sites (api/audit/route.ts, reprice.ts).
const API_REQUESTS = "api_requests";
const API_ITEMS = "api_items";

// Same reasoning again: Entry Refund Check is a distinct usage pattern
// (reviewing filed entries) from an interactive audit, so it gets its own
// scope rather than sharing -- or being capped by -- the audit budget.
const REFUND_CHECK_REQUESTS = "refund_check_requests";
const REFUND_CHECK_ITEMS = "refund_check_items";

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
 *  subject's lease so two calls cannot both pass the check.
 *
 *  Takes the resolved budget directly, not a Tier: a signed-in caller's real
 *  ceiling depends on their plan (lib/plans.ts's PLAN_LIMITS), which a static
 *  Record<Tier, ...> cannot express -- only the caller (which already knows
 *  the viewer's resolved limits) can build the right budget. */
export async function chargeAudit(subject: string, budget: AuditBudget, items: number): Promise<Charge> {
  await sweep();
  const requestWait = await waitFor(REQUESTS, subject, budget.requests, 1);
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

/** Same shape as chargeAudit, for the programmatic API (lib/apiKeys.ts,
 *  app/api/v1/audit). Its own scope constants (API_REQUESTS/API_ITEMS) keep
 *  this budget independent of the web UI's -- see the constants' own comment
 *  for why. */
export async function chargeApi(subject: string, budget: AuditBudget, items: number): Promise<Charge> {
  await sweep();
  const requestWait = await waitFor(API_REQUESTS, subject, budget.requests, 1);
  const itemWait = await waitFor(API_ITEMS, subject, budget.items, items);
  if (requestWait || itemWait) {
    const over = itemWait >= requestWait && itemWait ? "items" : "requests";
    const wait = Math.max(requestWait, itemWait);
    return { ok: false, over, tooLarge: !Number.isFinite(wait),
             retryAfter: Number.isFinite(wait) ? wait : Math.ceil(budget.items.windowMs / 1000) };
  }
  const at = new Date().toISOString();
  await record(API_REQUESTS, subject, at, 1);
  await record(API_ITEMS, subject, at, items);
  return {
    ok: true,
    refund: async () => {
      await (await db()).execute({
        sql: "DELETE FROM usage_event WHERE subject = ? AND at = ? AND scope IN (?, ?)",
        args: [subject, at, API_REQUESTS, API_ITEMS],
      });
    },
  };
}

/** Same shape again, for Entry Refund Check (lib/refundCheck.ts). */
export async function chargeRefundCheck(subject: string, budget: AuditBudget, items: number): Promise<Charge> {
  await sweep();
  const requestWait = await waitFor(REFUND_CHECK_REQUESTS, subject, budget.requests, 1);
  const itemWait = await waitFor(REFUND_CHECK_ITEMS, subject, budget.items, items);
  if (requestWait || itemWait) {
    const over = itemWait >= requestWait && itemWait ? "items" : "requests";
    const wait = Math.max(requestWait, itemWait);
    return { ok: false, over, tooLarge: !Number.isFinite(wait),
             retryAfter: Number.isFinite(wait) ? wait : Math.ceil(budget.items.windowMs / 1000) };
  }
  const at = new Date().toISOString();
  await record(REFUND_CHECK_REQUESTS, subject, at, 1);
  await record(REFUND_CHECK_ITEMS, subject, at, items);
  return {
    ok: true,
    refund: async () => {
      await (await db()).execute({
        sql: "DELETE FROM usage_event WHERE subject = ? AND at = ? AND scope IN (?, ?)",
        args: [subject, at, REFUND_CHECK_REQUESTS, REFUND_CHECK_ITEMS],
      });
    },
  };
}

/** Records one hit and returns null, or returns seconds to wait when the
 *  caller is over `limit`. Refused hits are not recorded. */
export async function allow(scope: string, subject: string, limit: Limit): Promise<number | null> {
  await sweep();
  const now = Date.now();
  const result = await (await db()).execute({
    sql: `INSERT INTO usage_event(scope,subject,at,cost) SELECT ?,?,?,1
      WHERE (SELECT coalesce(sum(cost),0) FROM usage_event WHERE scope = ? AND subject = ? AND at >= ?) < ?`,
    args: [scope, subject, new Date(now).toISOString(), scope, subject, new Date(now - limit.windowMs).toISOString(), limit.max],
  });
  return result.rowsAffected ? null : (await waitFor(scope, subject, limit, 1)) || 1;
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
