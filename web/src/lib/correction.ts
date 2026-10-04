import crypto from "node:crypto";
import type { Client } from "@libsql/client";
import { API_BASE } from "./api";
import { acquireLease, chargeAudit } from "./budget";
import { getCatalogue, isWatchable } from "./catalogues";
import { signedBodyFromEngine, type EngineRequest } from "./auditProof";
import type { SavedLine } from "./auditModel";
import { db, planFor } from "./store";
import { MAX_REVIEW_EVENTS } from "./reviewModel";

/** Correcting a saved line's own facts (HTS, origin, value, quantity) and
 *  recalculating its price against the engine — the one thing neither
 *  review.ts (approval/assignment only) nor reprice.ts (resubmits every
 *  line's facts UNCHANGED) can do.
 *
 *  Two steps, not one: `proposeCorrection` spends the one metered engine
 *  call and stores the result as a short-lived draft; `confirmCorrection`
 *  does the one atomic write, from the stored draft, with no second engine
 *  call. This lets the review page show a real before/after without ever
 *  holding untrusted state in the browser — unlike the original audit-save
 *  flow (auditProof.ts's signAudit/verifyAudit), this page has no client JS
 *  and nothing round-trips through it, so there is nothing to sign.
 *
 *  A correction's write deliberately differs from reprice.ts's in two ways:
 *  it always writes country/value/quantity/quantity_unit (reprice.ts never
 *  touches these — it only ever resubmits them unchanged), and it always
 *  bumps review_version and reopens an approved line to pending, not only
 *  when the price materially changed — the facts an approval rested on
 *  changed, regardless of whether the duty number happens to land the same.
 *  Evidence is always replaced with the fresh response for the same reason
 *  reprice.ts keeps old evidence: there, hts never changes, so there is
 *  nothing fresher to show; here, that is exactly what might have changed.
 */

export type CorrectionOverrides = {
  hts?: string; country?: string; value?: number;
  quantity?: number; quantity_unit?: string;
};

export type ProposeOutcome =
  | { ok: true; draftId: string }
  | { ok: false; error: string; retryAfter?: number };

export type ConfirmOutcome =
  | { ok: true }
  | { ok: false; error: string };

const DRAFT_MAX_AGE_MS = 60 * 60 * 1000;
const digitsOf = (hts?: string | null) => (hts ? hts.replace(/\./g, "") : null);

let ready: Promise<void> | null = null;
async function ensureSchema(c: Client): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await c.execute(`
        CREATE TABLE IF NOT EXISTS catalogue_item_correction (
          id              TEXT PRIMARY KEY,
          item_id         TEXT NOT NULL REFERENCES catalogue_item(id) ON DELETE CASCADE,
          account_id      TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
          review_version  INTEGER NOT NULL,
          overrides_json  TEXT NOT NULL,
          line_json       TEXT NOT NULL,
          created_at      TEXT NOT NULL
        )
      `);
      await c.execute(
        "CREATE INDEX IF NOT EXISTS item_correction_item ON catalogue_item_correction(item_id, created_at)");
    })().catch((error) => { ready = null; throw error; });
  }
  await ready;
}
async function conn(): Promise<Client> {
  const c = await db();
  await ensureSchema(c);
  return c;
}

/** Spends one metered engine call pricing the item's current facts with
 *  `overrides` applied on top, and stores the result as a draft awaiting
 *  confirmation. Fails cheaply (before any engine call) on a stale version. */
export async function proposeCorrection(
  accountId: string, catalogueId: string, itemId: string,
  overrides: CorrectionOverrides, version: number,
): Promise<ProposeOutcome> {
  const cat = await getCatalogue(accountId, catalogueId);
  if (!cat) return { ok: false, error: "Catalogue not found." };
  const before = cat.items.find((i) => i.id === itemId);
  if (!before) return { ok: false, error: "Product not found." };
  if (before.review_version !== version) {
    return { ok: false, error: "This line changed since you opened it. Refresh and try again." };
  }

  // Per-item, not per-account like reprice.ts's lease: correcting one line
  // should not block correcting an unrelated one on the same catalogue.
  const release = await acquireLease(`account:${accountId}:item:${itemId}`);
  if (!release) {
    return { ok: false, error: "A correction is already running for this line. Try again shortly.", retryAfter: 5 };
  }
  try {
    // The same budget scope reprice.ts uses, on purpose (its own comment:
    // "the same engine call an audit makes... metered the same way") -- not
    // a new scope, and charged per-account like every other audit spend.
    const { limits } = await planFor(accountId);
    const budget = { requests: limits.auditRequests, items: limits.itemsPerDay };
    const charge = await chargeAudit(`account:${accountId}`, budget, 1);
    if (!charge.ok) {
      return {
        ok: false, retryAfter: charge.retryAfter,
        error: charge.tooLarge
          ? "This request is larger than the daily allowance for a single run."
          : "You have reached your audit allowance. Try again in a while.",
      };
    }

    const item = {
      row: 1,
      sku: before.sku ?? "",
      description: before.description,
      country: overrides.country ?? before.country,
      value: overrides.value ?? before.value,
      hts: overrides.hts !== undefined ? overrides.hts : before.hts,
      quantity: overrides.quantity ?? before.quantity ?? undefined,
      quantity_unit: overrides.quantity_unit ?? before.quantity_unit ?? undefined,
      preference_program: before.preference_program ?? undefined,
      end_use: before.end_use ?? undefined,
      metal_weight_pct: before.metal_weight_pct ?? undefined,
      vehicle_use: before.vehicle_use ?? undefined,
    };
    // entries/by_vessel explicitly carried, not omitted: signedBodyFromEngine
    // silently defaults these to 1/vessel when absent, which would mis-price
    // MPF/HMF for any catalogue that isn't a single-entry vessel shipment.
    const request = { items: [item], entries: cat.entries, by_vessel: !!cat.by_vessel, formal_entry: true };

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
      if (!res.ok) return { ok: false, error: "The duty engine could not price this correction. Try again shortly." };
      engineResponse = await res.json();
    } catch {
      await charge.refund();
      return { ok: false, error: "The duty engine is unavailable. Try again shortly." };
    }

    const signed = signedBodyFromEngine(engineResponse, request as EngineRequest);
    if (!signed || signed.lines.length !== 1) {
      return { ok: false, error: "The engine's response could not be read. Try again shortly." };
    }

    const c = await conn();
    const id = crypto.randomUUID();
    await c.execute({
      sql: `INSERT INTO catalogue_item_correction(id, item_id, account_id, review_version, overrides_json, line_json, created_at)
            VALUES(?,?,?,?,?,?,?)`,
      args: [id, itemId, accountId, version, JSON.stringify(overrides), JSON.stringify(signed.lines[0]), new Date().toISOString()],
    });
    return { ok: true, draftId: id };
  } finally {
    await release();
  }
}

/** Commits a previously proposed draft: one atomic write, no second engine
 *  call. Fails if the line moved since the draft was proposed (optimistic
 *  concurrency, same as every other review write) or the draft expired. */
export async function confirmCorrection(
  accountId: string, actor: string, catalogueId: string, itemId: string, draftId: string, version: number,
): Promise<ConfirmOutcome> {
  const cat = await getCatalogue(accountId, catalogueId);
  if (!cat) return { ok: false, error: "Catalogue not found." };
  const before = cat.items.find((i) => i.id === itemId);
  if (!before) return { ok: false, error: "Product not found." };
  if (before.review_version !== version) {
    return { ok: false, error: "This line changed since you proposed the correction. Recalculate again." };
  }

  const c = await conn();
  const draftRs = await c.execute({
    sql: "SELECT overrides_json, line_json, created_at FROM catalogue_item_correction WHERE id = ? AND item_id = ? AND account_id = ?",
    args: [draftId, itemId, accountId],
  });
  const draft = draftRs.rows[0] as unknown as { overrides_json: string; line_json: string; created_at: string } | undefined;
  if (!draft) return { ok: false, error: "This correction could not be found. Recalculate again." };
  if (Date.now() - new Date(draft.created_at).getTime() > DRAFT_MAX_AGE_MS) {
    await c.execute({ sql: "DELETE FROM catalogue_item_correction WHERE id = ?", args: [draftId] });
    return { ok: false, error: "This correction has expired. Recalculate again." };
  }

  const overrides = JSON.parse(draft.overrides_json) as CorrectionOverrides;
  const line = JSON.parse(draft.line_json) as SavedLine;
  const list = (v?: string[]) => (v?.length ? JSON.stringify(v) : null);
  const country = overrides.country ?? before.country;
  const value = overrides.value ?? before.value;
  const quantity = overrides.quantity !== undefined ? overrides.quantity : before.quantity;
  const quantityUnit = overrides.quantity_unit !== undefined ? overrides.quantity_unit : before.quantity_unit;
  const evidenceJson = line.evidence ? JSON.stringify(line.evidence) : null;

  const result = await c.execute({
    sql: `UPDATE catalogue_item SET
            hts = ?, digits = ?, confidence = ?, duty = ?, effective_rate = ?, refundable = ?,
            scope_unverified = ?, status = ?, error = ?, review_json = ?, warnings_json = ?,
            incomplete_json = ?, evidence_json = ?,
            country = ?, value = ?, quantity = ?, quantity_unit = ?,
            review_version = review_version + 1,
            approval_status = CASE WHEN approval_status = 'approved' THEN 'pending' ELSE approval_status END
          WHERE id = ? AND review_version = ?`,
    args: [
      line.hts ?? null, digitsOf(line.hts), line.confidence ?? null,
      line.duty ?? null, line.effective_rate_pct ?? null, line.refundable ?? null,
      line.scope_unverified?.length ? 1 : 0,
      line.status, line.error ?? null,
      list(line.review_reasons), list(line.warnings), list(line.incomplete),
      evidenceJson,
      country, value, quantity ?? null, quantityUnit ?? null,
      itemId, version,
    ],
  });
  if (result.rowsAffected !== 1) {
    return { ok: false, error: "This line changed since you proposed the correction. Recalculate again." };
  }

  // Only the completeness flag is derived locally; mpf/dataset_revision/
  // assumptions from a ONE-ITEM engine call are meaningless for the whole
  // catalogue and must never be written back (they'd silently corrupt the
  // catalogue's real aggregate figures).
  const remaining = await c.execute({
    sql: "SELECT count(*) AS n FROM catalogue_item WHERE catalogue_id = ? AND (status IS NULL OR status != 'ready')",
    args: [catalogueId],
  });
  const totalsComplete = (remaining.rows[0] as unknown as { n: number }).n === 0 ? 1 : 0;
  await c.execute({
    sql: "UPDATE catalogue SET totals_complete = ?, updated_at = ? WHERE id = ?",
    args: [totalsComplete, new Date().toISOString(), catalogueId],
  });

  if (before.hts !== line.hts) {
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
        args: [accountId, digitsOf(line.hts), line.hts, catalogueId, new Date().toISOString()],
      });
    }
  }

  const fmt = (d: number | null | undefined) => (d === null || d === undefined ? "unpriced" : `$${d.toFixed(2)}`);
  const changes: string[] = [];
  if (before.hts !== line.hts) changes.push(`HTS ${before.hts ?? "none"} → ${line.hts ?? "none"}`);
  if (before.country !== country) changes.push(`country ${before.country} → ${country}`);
  if (before.value !== value) changes.push(`value ${fmt(before.value)} → ${fmt(value)}`);
  if ((before.quantity ?? null) !== (quantity ?? null)) changes.push(`quantity ${before.quantity ?? "none"} → ${quantity ?? "none"}`);
  changes.push(`duty ${fmt(before.duty)} → ${fmt(line.duty ?? null)}`);
  try {
    await c.execute({
      sql: `INSERT INTO catalogue_item_event(id,item_id,account_id,kind,actor,approval_status,assigned_to,comment,created_at,version)
            SELECT ?,id,?,?,?,approval_status,assigned_to,?,?,review_version FROM catalogue_item
            WHERE id = ? AND (SELECT count(*) FROM catalogue_item_event e JOIN catalogue_item i ON i.id = e.item_id
                                WHERE i.catalogue_id = catalogue_item.catalogue_id) < ?`,
      args: [crypto.randomUUID(), accountId, "correction", actor, `Corrected: ${changes.join("; ")}.`, new Date().toISOString(), itemId, MAX_REVIEW_EVENTS],
    });
  } catch { /* best-effort: the write above already committed */ }

  try {
    await c.execute({ sql: "DELETE FROM catalogue_item_correction WHERE id = ?", args: [draftId] });
  } catch { /* best-effort cleanup */ }

  return { ok: true };
}

/** The draft awaiting confirmation for an item, or null if there is none,
 *  it's someone else's, or it has expired (expired drafts are not deleted
 *  here -- confirmCorrection deletes on the attempt, this is read-only). */
export async function getDraft(
  accountId: string, itemId: string, draftId: string,
): Promise<{ overrides: CorrectionOverrides; line: SavedLine } | null> {
  const c = await conn();
  const rs = await c.execute({
    sql: "SELECT overrides_json, line_json, created_at FROM catalogue_item_correction WHERE id = ? AND item_id = ? AND account_id = ?",
    args: [draftId, itemId, accountId],
  });
  const row = rs.rows[0] as unknown as { overrides_json: string; line_json: string; created_at: string } | undefined;
  if (!row) return null;
  if (Date.now() - new Date(row.created_at).getTime() > DRAFT_MAX_AGE_MS) return null;
  return { overrides: JSON.parse(row.overrides_json), line: JSON.parse(row.line_json) };
}
