/** Re-pricing a saved catalogue: re-submits every line's own stored code (or,
 *  for a line that never got one, its description) and facts to the engine
 *  again, and updates the catalogue in place with whatever comes back —
 *  instead of the customer re-uploading the same CSV to watch for what
 *  changed under it.
 *
 *  This is the same engine call an audit makes, so it is metered the same
 *  way (lib/budget.ts) and against the same account subject: a re-price is
 *  real engine work, not a free refresh loop.
 *
 *  What it deliberately does NOT touch: a line's sku, description, country,
 *  entered value, or its stated facts (quantity, preference program, end
 *  use, metal weight, vehicle use) — those are resubmitted unchanged, never
 *  guessed at or reset to "not claimed". Evidence (ruling snapshots) is kept
 *  for a line that already had a code: a re-price never re-classifies an
 *  already-classified line, so there is no fresh evidence to replace it
 *  with, and overwriting it with "no_classifier_evidence" would erase a
 *  real record for no reason. A line that never had a code IS re-classified
 *  (the same engine call does that when hts is empty), and its fresh
 *  evidence, if any, is saved.
 */
import crypto from "node:crypto";
import { API_BASE } from "./api";
import { acquireLease, chargeAudit } from "./budget";
import { getCatalogue, isWatchable, type CatalogueItem } from "./catalogues";
import { signedBodyFromEngine, type EngineRequest } from "./auditProof";
import type { SavedLine } from "./auditModel";
import { db, planFor } from "./store";
import { MAX_REVIEW_EVENTS } from "./reviewModel";

export type RepriceOutcome =
  | { ok: true; changed: number; unchanged: number; totalsComplete: boolean }
  | { ok: false; error: string; retryAfter?: number };

const digitsOf = (hts?: string | null) => (hts ? hts.replace(/\./g, "") : null);

/** True when a re-priced line differs from what was saved in a way worth
 *  telling the customer about and reopening review for — the price itself,
 *  or the code, or whether it is now resolved at all. A cosmetic change
 *  (a warning's exact wording) does not count. */
function materiallyChanged(before: CatalogueItem, after: SavedLine): boolean {
  if ((before.status ?? "ready") !== after.status) return true;
  if (before.hts !== after.hts) return true;
  const near = (a: number | null, b: number | undefined) =>
    Math.abs((a ?? 0) - (b ?? 0)) > 0.005; // a cent, allowing for float noise
  return near(before.duty, after.duty) || near(before.refundable, after.refundable);
}

export async function repriceCatalogue(accountId: string, catalogueId: string): Promise<RepriceOutcome> {
  const cat = await getCatalogue(accountId, catalogueId);
  if (!cat) return { ok: false, error: "Catalogue not found." };
  if (!cat.items.length) return { ok: false, error: "This catalogue has no lines to re-price." };

  const items = cat.items.map((it, i) => ({
    row: i + 1,
    sku: it.sku ?? "",
    description: it.description,
    country: it.country,
    value: it.value,
    hts: it.hts,
    quantity: it.quantity ?? undefined,
    quantity_unit: it.quantity_unit ?? undefined,
    preference_program: it.preference_program ?? undefined,
    end_use: it.end_use ?? undefined,
    metal_weight_pct: it.metal_weight_pct ?? undefined,
    vehicle_use: it.vehicle_use ?? undefined,
  }));
  const request = { items, entries: cat.entries, by_vessel: !!cat.by_vessel, formal_entry: true };

  const subject = `account:${accountId}`;
  const release = await acquireLease(subject);
  if (!release) return { ok: false, error: "An audit is already running for this account. Try again shortly.", retryAfter: 5 };
  try {
    // The account's real plan budget, not a flat free-tier one -- a
    // starter/growth account repricing a large catalogue was previously
    // charged (and could be refused) against the free ceiling regardless of
    // what it actually pays for.
    const { limits } = await planFor(accountId);
    const budget = { requests: limits.auditRequests, items: limits.itemsPerDay };
    const charge = await chargeAudit(subject, budget, items.length);
    if (!charge.ok) {
      return {
        ok: false, retryAfter: charge.retryAfter,
        error: charge.tooLarge
          ? "This catalogue is larger than the daily allowance for a single run."
          : `You have reached your audit allowance. Try again in a while.`,
      };
    }
    let engineResponse: unknown;
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      const key = process.env.HTSDESK_API_KEY;
      if (key) headers["x-api-key"] = key;
      const res = await fetch(`${API_BASE}/api/audit`, {
        method: "POST", headers, body: JSON.stringify(request),
        cache: "no-store", signal: AbortSignal.timeout(55_000),
      });
      if (res.status >= 500) await charge.refund();
      if (!res.ok) return { ok: false, error: "The duty engine could not re-price this catalogue. Try again shortly." };
      engineResponse = await res.json();
    } catch (error) {
      // A timeout does not establish that the engine stopped doing work.
      if (!(error instanceof Error && error.name === "TimeoutError")) await charge.refund();
      return { ok: false, error: "The duty engine is unavailable. Try again shortly." };
    }

    const signed = signedBodyFromEngine(engineResponse, request as EngineRequest);
    if (!signed) return { ok: false, error: "The engine's response could not be read. Try again shortly." };
    if (signed.lines.length !== cat.items.length) {
      return { ok: false, error: "The engine returned a different number of lines than were submitted." };
    }

    const c = await db();
    const now = new Date().toISOString();
    let changed = 0;
    const reopened: { itemId: string; was: string; now: string }[] = [];
    const list = (v?: string[]) => (v?.length ? JSON.stringify(v) : null);
    const statements = signed.lines.map((line, i) => {
      const before = cat.items[i];
      const hadCode = !!before.hts;
      const evidenceJson = hadCode
        ? before.evidence_json // already classified: keep the existing evidence, nothing fresh to replace it with
        : (line.evidence ? JSON.stringify(line.evidence) : null);
      const isChanged = materiallyChanged(before, line);
      if (isChanged) changed += 1;
      // An approval asserted the OLD numbers were fine; a material change
      // under it is not still asserted by anyone, so it is reopened here, in
      // the SAME statement that changes the numbers — not a separate,
      // best-effort call afterward, whose failure (the per-catalogue review-
      // event cap, a dropped connection) would otherwise leave the screen
      // reading "Approved" against figures that no longer exist with nothing
      // to say so. review_version bumps on every material change regardless
      // of approval state, not only a previously-approved one, so a stale
      // review form open on ANY state (not just "approved") fails its own
      // optimistic-concurrency check instead of silently landing against
      // numbers it was never shown.
      if (isChanged && before.review_status === "approved") {
        reopened.push({
          itemId: before.id,
          was: before.duty === null ? "unpriced" : `$${before.duty.toFixed(2)}`,
          now: line.duty === undefined ? "unpriced" : `$${line.duty.toFixed(2)}`,
        });
      }
      return {
        sql: `UPDATE catalogue_item SET
                hts = ?, digits = ?, confidence = ?, duty = ?, effective_rate = ?, refundable = ?,
                scope_unverified = ?, status = ?, error = ?, review_json = ?, warnings_json = ?,
                incomplete_json = ?, evidence_json = ?,
                review_version = review_version + ?,
                approval_status = CASE WHEN ? = 1 AND approval_status = 'approved' THEN 'pending' ELSE approval_status END
              WHERE id = ?`,
        args: [
          line.hts ?? null, digitsOf(line.hts), line.confidence ?? null,
          line.duty ?? null, line.effective_rate_pct ?? null, line.refundable ?? null,
          line.scope_unverified?.length ? 1 : 0,
          line.status, line.error ?? null,
          list(line.review_reasons), list(line.warnings), list(line.incomplete),
          evidenceJson,
          isChanged ? 1 : 0,
          isChanged ? 1 : 0,
          before.id,
        ],
      };
    });

    const complete = signed.lines.length > 0 && signed.lines.every((l) => l.status === "ready");
    statements.push({
      sql: `UPDATE catalogue SET dataset_revision = ?, assumptions_json = ?, totals_complete = ?,
              calculated_at = ?, mpf = ?, updated_at = ? WHERE id = ?`,
      args: [
        signed.dataset_revision, JSON.stringify(signed.assumptions), complete ? 1 : 0,
        signed.at, signed.mpf, now, catalogueId,
      ] as (string | number)[],
    });
    await c.batch(statements, "write");

    // A line whose code changed may need to swap which code is watched; one
    // that is no longer classified drops its watch, and one newly classified
    // picks one up. Best-effort: a saved catalogue exists to be watched, but
    // this is bookkeeping around the price itself, which is already saved.
    for (const [i, line] of signed.lines.entries()) {
      const before = cat.items[i];
      if (before.hts === line.hts) continue;
      if (before.hts) {
        await c.execute({
          sql: "DELETE FROM watched_code WHERE account_id = ? AND catalogue_id = ? AND digits = ?",
          args: [accountId, catalogueId, digitsOf(before.hts)],
        });
      }
      if (line.hts && isWatchable(line)) {
        await c.execute({
          sql: `INSERT OR IGNORE INTO watched_code(account_id, digits, hts, catalogue_id, created_at)
                VALUES(?,?,?,?,?)`,
          args: [accountId, digitsOf(line.hts), line.hts, catalogueId, now],
        });
      }
    }

    // The reopen itself already committed atomically with the price change,
    // above — this is only the human-readable line in the history feed
    // explaining why. It is genuinely best-effort (the per-catalogue
    // MAX_REVIEW_EVENTS cap can refuse it, same as any other review event),
    // and unlike before, that is safe to be best-effort now: the approval
    // state itself does not depend on this succeeding.
    for (const r of reopened) {
      try {
        await c.execute({
          sql: `INSERT INTO catalogue_item_event(id,item_id,account_id,kind,actor,approval_status,assigned_to,comment,created_at,version)
                SELECT ?,id,?,?,?,approval_status,assigned_to,?,?,review_version FROM catalogue_item
                WHERE id = ? AND (SELECT count(*) FROM catalogue_item_event e JOIN catalogue_item i ON i.id = e.item_id
                                    WHERE i.catalogue_id = catalogue_item.catalogue_id) < ?`,
          args: [
            crypto.randomUUID(), accountId, "approval", "Re-price (system)",
            `Reopened: re-pricing changed this line (duty ${r.was} → ${r.now}); review the new figures.`,
            now, r.itemId, MAX_REVIEW_EVENTS,
          ],
        });
      } catch { /* best-effort: the approval state itself is already correct regardless */ }
    }

    return { ok: true, changed, unchanged: signed.lines.length - changed, totalsComplete: complete };
  } finally {
    await release();
  }
}
