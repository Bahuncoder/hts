import crypto from "node:crypto";
import { API_BASE, engineHeaders } from "./api";
import { acquireLease, chargeRefundCheck, type AuditBudget } from "./budget";
import { computeRefundTiming } from "./refundTiming";
import type { RefundCheckRow } from "./refundCheckCsv";
import { db } from "./store";

/** Entry Refund Check: a customer supplies facts about an entry they already
 *  filed, and the engine -- unchanged, same call as the forward-looking
 *  audit -- prices it under today's rules. The engine never receives or
 *  knows about entry_date/duty_paid/liquidation_date; those are pure
 *  web-app orchestration, compared here against the engine's own
 *  struck-down-IEEPA `refundable` figure (core/duty.py), attributed against
 *  a real stated duty_paid instead of a hypothetical one. See
 *  lib/refundTiming.ts for the PSC/protest/liquidation timing logic.
 *
 *  Deliberately does NOT diff duty_paid against the engine's freshly
 *  computed total, or flag a classification difference from what was
 *  declared: either invites reading an unconfirmed comparison as HTSDesk
 *  asserting a legal overpayment finding, exactly what `terms/page.tsx` §3
 *  disclaims. 3a stays to the one figure with a clean, entry-independent
 *  legal basis. */

export type RefundCheckItemResult = {
  row: number; sku: string; description: string; country: string; value: number;
  entryHts: string | null; entryDate: string; dutyPaid: number; liquidationDate: string | null;
  computedHts: string | null; computedDuty: number | null; struckDownRefundable: number;
  pscEligible: string; pscDetail: string; protestDeadline: string; protestDetail: string;
  disclaimer: string; status: string;
};

export class RefundCheckLimitError extends Error {
  constructor(readonly max: number) {
    super(`You have ${max} saved refund checks. Delete one to save another.`);
  }
}

/** Carries the budget-refusal detail (retry timing, which limit was hit) so
 *  the route can build the same kind of specific, actionable message the
 *  audit route gives for its own budget refusals. */
export class RefundCheckBudgetError extends Error {
  constructor(readonly retryAfter: number, readonly over: "requests" | "items", readonly tooLarge: boolean) {
    super("budget exceeded");
  }
}

type EngineLine = {
  hts?: string | null; duty?: number; refundable?: number; status: string;
};

/** A row the caller has already validated has a real entry date -- the
 *  schema's entry_date column is NOT NULL, and timing cannot be computed at
 *  all without one. Validating this is the route's job (it reports which
 *  rows were rejected and why); this function assumes every row it receives
 *  is complete enough to price and persist. */
export type ValidRefundCheckRow = RefundCheckRow & { entryDate: string };

async function callEngine(items: ValidRefundCheckRow[]): Promise<EngineLine[]> {
  const request = {
    items: items.map((it) => ({
      row: it.row, sku: it.sku || undefined, description: it.description,
      country: it.country, value: it.value, hts: it.entryHts || undefined,
    })),
    entries: 1, by_vessel: true, formal_entry: true,
  };
  const res = await fetch(`${API_BASE}/api/audit`, {
    method: "POST",
    headers: { "content-type": "application/json", ...engineHeaders() },
    body: JSON.stringify(request),
    cache: "no-store",
    signal: AbortSignal.timeout(55_000),
  });
  if (!res.ok) throw new Error(`engine returned ${res.status}`);
  const body = (await res.json()) as { lines: EngineLine[] };
  return body.lines;
}

/** Runs the engine over every item, computes the struck-down-refundable
 *  attribution and timing flags, and saves the result. Throws
 *  RefundCheckLimitError when the account is already at its plan's cap. */
export async function runRefundCheck(
  accountId: string, name: string, items: ValidRefundCheckRow[], budget: AuditBudget, maxChecks: number,
): Promise<{ id: string; items: RefundCheckItemResult[] }> {
  const subject = `account:${accountId}`;
  const release = await acquireLease(`refund-check:${accountId}`);
  if (!release) throw new Error("A refund check is already running for this account.");
  try {
    const charge = await chargeRefundCheck(subject, budget, items.length);
    if (!charge.ok) throw new RefundCheckBudgetError(charge.retryAfter, charge.over, charge.tooLarge);

    let lines: EngineLine[];
    try {
      lines = await callEngine(items);
    } catch (err) {
      await charge.refund();
      throw err;
    }
    if (lines.length !== items.length) {
      await charge.refund();
      throw new Error("engine returned a different number of lines than were submitted");
    }

    const now = new Date().toISOString();
    const results: RefundCheckItemResult[] = items.map((item, i) => {
      const line = lines[i];
      const timing = computeRefundTiming(
        new Date(item.entryDate), item.liquidationDate ? new Date(item.liquidationDate) : null,
      );
      return {
        row: item.row, sku: item.sku, description: item.description, country: item.country, value: item.value,
        entryHts: item.entryHts, entryDate: item.entryDate, dutyPaid: item.dutyPaid,
        liquidationDate: item.liquidationDate,
        computedHts: line.hts ?? null, computedDuty: line.duty ?? null,
        struckDownRefundable: line.refundable ?? 0,
        pscEligible: timing.pscEligible, pscDetail: timing.pscDetail,
        protestDeadline: timing.protestDeadline, protestDetail: timing.protestDetail,
        disclaimer: timing.disclaimer, status: line.status,
      };
    });

    const c = await db();
    const tx = await c.transaction("write");
    const id = crypto.randomUUID();
    try {
      const held = await tx.execute({
        sql: "SELECT count(*) AS n FROM refund_check WHERE account_id = ?", args: [accountId],
      });
      if ((held.rows[0] as unknown as { n: number }).n >= maxChecks) {
        throw new RefundCheckLimitError(maxChecks);
      }
      await tx.execute({
        sql: "INSERT INTO refund_check(id, account_id, name, created_at, updated_at) VALUES(?,?,?,?,?)",
        args: [id, accountId, name, now, now],
      });
      for (const r of results) {
        await tx.execute({
          sql: `INSERT INTO refund_check_item(id, refund_check_id, row, sku, description, country, value,
                  entry_hts, entry_date, duty_paid, liquidation_date, computed_hts, computed_duty,
                  struck_down_refundable, psc_eligible, psc_detail, protest_deadline, protest_detail,
                  disclaimer, status)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          args: [
            crypto.randomUUID(), id, r.row, r.sku || null, r.description, r.country, r.value,
            r.entryHts, r.entryDate, r.dutyPaid, r.liquidationDate, r.computedHts, r.computedDuty,
            r.struckDownRefundable, r.pscEligible, r.pscDetail, r.protestDeadline, r.protestDetail,
            r.disclaimer, r.status,
          ],
        });
      }
      await tx.commit();
    } catch (err) {
      await tx.rollback();
      throw err;
    }
    return { id, items: results };
  } finally {
    await release();
  }
}

export type RefundCheckSummary = { id: string; name: string; created_at: string; updated_at: string; items: number; struck_down_refundable: number };

export async function listRefundChecks(accountId: string): Promise<RefundCheckSummary[]> {
  const rs = await (await db()).execute({
    sql: `SELECT c.id, c.name, c.created_at, c.updated_at, count(i.id) AS items,
                 COALESCE(sum(i.struck_down_refundable), 0) AS struck_down_refundable
            FROM refund_check c
            LEFT JOIN refund_check_item i ON i.refund_check_id = c.id
           WHERE c.account_id = ?
           GROUP BY c.id
           ORDER BY c.created_at DESC`,
    args: [accountId],
  });
  return rs.rows as unknown as RefundCheckSummary[];
}

/** The raw stored row shape (snake_case columns), distinct from
 *  RefundCheckItemResult (the camelCase shape computed fresh by a run and
 *  sent to the client) -- getRefundCheck reads back what was persisted. */
export type RefundCheckItemRow = {
  id: string; refund_check_id: string; row: number; sku: string | null; description: string;
  country: string; value: number; entry_hts: string | null; entry_date: string; duty_paid: number;
  liquidation_date: string | null; computed_hts: string | null; computed_duty: number | null;
  struck_down_refundable: number; psc_eligible: string | null; psc_detail: string | null;
  protest_deadline: string | null; protest_detail: string | null; disclaimer: string | null; status: string;
};

export async function getRefundCheck(accountId: string, id: string) {
  const c = await db();
  const metaRs = await c.execute({
    sql: "SELECT id, name, created_at, updated_at FROM refund_check WHERE id = ? AND account_id = ?",
    args: [id, accountId],
  });
  const meta = metaRs.rows[0] as unknown as { id: string; name: string; created_at: string; updated_at: string } | undefined;
  if (!meta) return null;
  const itemsRs = await c.execute({
    sql: "SELECT * FROM refund_check_item WHERE refund_check_id = ? ORDER BY row", args: [id],
  });
  return { ...meta, items: itemsRs.rows as unknown as RefundCheckItemRow[] };
}

export async function deleteRefundCheck(accountId: string, id: string): Promise<boolean> {
  const rs = await (await db()).execute({
    sql: "DELETE FROM refund_check WHERE id = ? AND account_id = ?", args: [id, accountId],
  });
  return rs.rowsAffected > 0;
}
