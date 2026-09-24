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
import { API_BASE } from "./api";
import { acquireLease, chargeAudit, type Tier } from "./budget";
import { getCatalogue, isWatchable, type CatalogueItem } from "./catalogues";
import { signedBodyFromEngine, type EngineRequest } from "./auditProof";
import type { SavedLine } from "./auditModel";
import { db } from "./store";
import { setApproval } from "./review";

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

  const tier: Tier = "account";
  const subject = `account:${accountId}`;
  const release = await acquireLease(subject);
  if (!release) return { ok: false, error: "An audit is already running for this account. Try again shortly.", retryAfter: 5 };
  try {
    const charge = await chargeAudit(subject, tier, items.length);
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
    } catch {
      await charge.refund();
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
    const list = (v?: string[]) => (v?.length ? JSON.stringify(v) : null);
    const statements = signed.lines.map((line, i) => {
      const before = cat.items[i];
      const hadCode = !!before.hts;
      const evidenceJson = hadCode
        ? before.evidence_json // already classified: keep the existing evidence, nothing fresh to replace it with
        : (line.evidence ? JSON.stringify(line.evidence) : null);
      if (materiallyChanged(before, line)) changed += 1;
      return {
        sql: `UPDATE catalogue_item SET
                hts = ?, digits = ?, confidence = ?, duty = ?, effective_rate = ?, refundable = ?,
                scope_unverified = ?, status = ?, error = ?, review_json = ?, warnings_json = ?,
                incomplete_json = ?, evidence_json = ?
              WHERE id = ?`,
        args: [
          line.hts ?? null, digitsOf(line.hts), line.confidence ?? null,
          line.duty ?? null, line.effective_rate_pct ?? null, line.refundable ?? null,
          line.scope_unverified?.length ? 1 : 0,
          line.status, line.error ?? null,
          list(line.review_reasons), list(line.warnings), list(line.incomplete),
          evidenceJson,
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

    // An approval asserted the OLD numbers were fine; a material change
    // under it is not still asserted by anyone, so it is reopened, with a
    // system note explaining why, rather than left reading "Approved"
    // against figures that no longer exist.
    for (const [i, line] of signed.lines.entries()) {
      const before = cat.items[i];
      if (before.review_status !== "approved" || !materiallyChanged(before, line)) continue;
      const was = before.duty === null ? "unpriced" : `$${before.duty.toFixed(2)}`;
      const now2 = line.duty === undefined ? "unpriced" : `$${line.duty.toFixed(2)}`;
      try {
        await setApproval(accountId, "Re-price (system)", before.id, "pending",
          `Reopened: re-pricing changed this line (duty ${was} → ${now2}); review the new figures.`);
      } catch { /* best-effort; the price itself is already saved */ }
    }

    return { ok: true, changed, unchanged: signed.lines.length - changed, totalsComplete: complete };
  } finally {
    await release();
  }
}
