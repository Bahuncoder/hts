import crypto from "node:crypto";
import type { Client } from "@libsql/client";
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

type Conn = Pick<Client, "execute">;

/** Seconds until `cost` more work fits inside `limit`, or 0 if it fits now.
 *  Infinity when `cost` alone exceeds the whole allowance. Reads through `conn`
 *  so a caller can run it inside its own write transaction. */
async function waitFor(conn: Conn, scope: string, subject: string, limit: Limit, cost: number): Promise<number> {
  if (cost > limit.max) return Infinity;
  const now = Date.now();
  const rs = await conn.execute({
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

export type Charge =
  | { ok: true; refund: () => Promise<void> }
  | { ok: false; retryAfter: number; over: "requests" | "items"; tooLarge: boolean };

/** Both budget predicates and both charge rows belong to one atomic INSERT.
 * SQLite serializes this statement across connections without holding a
 * transaction open across JS awaits. Refunds use an unrepeatable reservation ID. */
async function chargeInScopes(requestScope: string, itemScope: string, subject: string,
                              budget: AuditBudget, items: number): Promise<Charge> {
  await sweep();
  const client = await db();
  const reservationId = crypto.randomUUID();
  const now = Date.now();
  const at = new Date(now).toISOString();
  const inserted = await client.execute({
    sql: `INSERT INTO usage_event(scope,subject,at,cost,reservation_id)
      SELECT scope,?,?,cost,? FROM (SELECT ? AS scope,1 AS cost UNION ALL SELECT ?,?)
      WHERE (SELECT coalesce(sum(cost),0) FROM usage_event WHERE scope = ? AND subject = ? AND at >= ?) <= ?
        AND (SELECT coalesce(sum(cost),0) FROM usage_event WHERE scope = ? AND subject = ? AND at >= ?) <= ?`,
    args: [subject, at, reservationId, requestScope, itemScope, items,
      requestScope, subject, new Date(now - budget.requests.windowMs).toISOString(), budget.requests.max - 1,
      itemScope, subject, new Date(now - budget.items.windowMs).toISOString(), budget.items.max - items],
  });
  if (inserted.rowsAffected !== 2) {
    const requestWait = await waitFor(client, requestScope, subject, budget.requests, 1);
    const itemWait = await waitFor(client, itemScope, subject, budget.items, items);
    const wait = Math.max(requestWait, itemWait);
    return { ok: false, over: itemWait >= requestWait && itemWait ? "items" : "requests",
      tooLarge: !Number.isFinite(wait),
      retryAfter: Number.isFinite(wait) ? Math.max(1, wait) : Math.ceil(budget.items.windowMs / 1000) };
  }
  return {
    ok: true,
    refund: async () => {
      await (await db()).execute({ sql: "DELETE FROM usage_event WHERE reservation_id = ?", args: [reservationId] });
    },
  };
}

/** Audit calls for the web UI (api/audit/route.ts, reprice.ts, corrections). */
export async function chargeAudit(subject: string, budget: AuditBudget, items: number): Promise<Charge> {
  return chargeInScopes(REQUESTS, ITEMS, subject, budget, items);
}

/** Same shape as chargeAudit, for the programmatic API (lib/apiKeys.ts,
 *  app/api/v1/audit). Its own scope constants (API_REQUESTS/API_ITEMS) keep
 *  this budget independent of the web UI's -- see the constants' own comment
 *  for why. */
export async function chargeApi(subject: string, budget: AuditBudget, items: number): Promise<Charge> {
  return chargeInScopes(API_REQUESTS, API_ITEMS, subject, budget, items);
}

/** Same shape again, for Entry Refund Check (lib/refundCheck.ts). */
export async function chargeRefundCheck(subject: string, budget: AuditBudget, items: number): Promise<Charge> {
  return chargeInScopes(REFUND_CHECK_REQUESTS, REFUND_CHECK_ITEMS, subject, budget, items);
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
  return result.rowsAffected ? null : (await waitFor(await db(), scope, subject, limit, 1)) || 1;
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
