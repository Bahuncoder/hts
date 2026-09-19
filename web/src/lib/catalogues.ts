import crypto from "node:crypto";
import { db } from "./store";
import {
  PRICED_STATUSES, isPriced, totalsOf,
  type SavedLine, type SignedAudit, type Status,
} from "./auditModel";

export type CatalogueSummary = {
  id: string; name: string; created_at: string; updated_at: string;
  items: number; value: number; duty: number; refundable: number;
  /** Lines that are not ready. For a catalogue saved before review states
   *  existed this is the old scope flag. */
  needs_review: number;
  totals_complete: number | null;
  mpf: number | null;
};

export type CatalogueItem = {
  id: string; row_number: number | null; sku: string | null; description: string;
  country: string; value: number; hts: string | null; digits: string | null;
  confidence: string | null; duty: number | null; effective_rate: number | null;
  refundable: number | null; scope_unverified: number;
  /** null: saved before review states existed. */
  status: Status | null;
  error: string | null;
  review: string[]; warnings: string[]; incomplete: string[];
};

export type CatalogueMeta = {
  id: string; name: string; created_at: string; updated_at: string;
  dataset_revision: string | null; assumptions: string[];
  /** null: saved before totals were labelled complete or partial. */
  totals_complete: number | null;
  calculated_at: string | null;
  mpf: number | null;
};

const digitsOf = (hts?: string | null) => (hts ? hts.replace(/\./g, "") : null);
const HTS_SHAPE = /^\d{4}\.\d{2}(\.\d{2}(\.\d{2})?)?$/;

/** Only a line the engine priced has a code it resolved and checked. An error
 *  line's code may be the very thing that was wrong, and an unclassified one
 *  has none, so those are saved (they stay on the work queue) but not watched. */
export function isWatchable(l: Pick<SavedLine, "status" | "hts">): boolean {
  return isPriced(l.status) && !!l.hts && HTS_SHAPE.test(l.hts);
}

const PRICED_SQL = PRICED_STATUSES.map((s) => `'${s}'`).join(",");

/** Saves a verified audit as a catalogue and watches every real code in it.
 *
 *  EVERY submitted line is stored, including the ones that could not be
 *  priced, with the state they were in: an unresolved product must never
 *  vanish from the saved work queue. `inputs[i]` is the amount the customer
 *  submitted for line i, kept for lines that carry no entered value of their
 *  own.
 *
 *  Watching is not a separate opt-in: a saved catalogue exists so we can tell
 *  the customer when something moves under it. Codes are recorded against the
 *  catalogue so deleting it withdraws exactly the watches it created and
 *  leaves any standalone ones alone.
 */
export async function saveCatalogue(
  accountId: string, name: string, audit: SignedAudit, inputs: number[] = [],
): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const complete = audit.lines.length > 0 && audit.lines.every((l) => l.status === "ready");
  const c = await db();
  const tx = await c.transaction("write");

  try {
    await tx.execute({
      sql: `INSERT INTO catalogue(id, account_id, name, created_at, updated_at,
              dataset_revision, assumptions_json, totals_complete, calculated_at, mpf)
            VALUES(?,?,?,?,?,?,?,?,?,?)`,
      args: [id, accountId, name, now, now, audit.dataset_revision,
        JSON.stringify(audit.assumptions), complete ? 1 : 0, audit.at, audit.mpf],
    });

    for (const [n, it] of audit.lines.entries()) {
      const digits = digitsOf(it.hts);
      const list = (v?: string[]) => (v?.length ? JSON.stringify(v) : null);
      await tx.execute({
        sql: `INSERT INTO catalogue_item(id, catalogue_id, sku, description, country, value,
                hts, digits, confidence, duty, effective_rate, refundable, scope_unverified,
                row_number, status, error, review_json, warnings_json, incomplete_json)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        args: [
          crypto.randomUUID(), id, it.sku || null, it.description, it.country,
          it.entered_value ?? inputs[n] ?? 0,
          it.hts ?? null, digits, it.confidence ?? null,
          it.duty ?? null, it.effective_rate_pct ?? null, it.refundable ?? null,
          it.scope_unverified?.length ? 1 : 0,
          it.row, it.status, it.error ?? null,
          list(it.review_reasons), list(it.warnings), list(it.incomplete),
        ],
      });
      if (isWatchable(it) && digits && it.hts) {
        await tx.execute({
          sql: `INSERT OR IGNORE INTO watched_code(account_id, digits, hts, catalogue_id, created_at)
                VALUES(?,?,?,?,?)`,
          args: [accountId, digits, it.hts, id, now],
        });
      }
    }
    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  }

  return id;
}

export async function listCatalogues(accountId: string): Promise<CatalogueSummary[]> {
  const rs = await (await db()).execute({
    sql: `SELECT c.id, c.name, c.created_at, c.updated_at, c.totals_complete, c.mpf,
                 count(i.id) AS items,
                 COALESCE(sum(CASE WHEN i.status IS NULL OR i.status IN (${PRICED_SQL})
                                   THEN i.value END), 0) AS value,
                 COALESCE(sum(i.duty), 0)       AS duty,
                 COALESCE(sum(i.refundable), 0) AS refundable,
                 COALESCE(sum(CASE WHEN i.status IS NULL THEN i.scope_unverified
                                   WHEN i.status = 'ready' THEN 0 ELSE 1 END), 0) AS needs_review
            FROM catalogue c
            LEFT JOIN catalogue_item i ON i.catalogue_id = c.id
           WHERE c.account_id = ?
           GROUP BY c.id
           ORDER BY c.updated_at DESC`,
    args: [accountId],
  });
  return rs.rows as unknown as CatalogueSummary[];
}

function jsonList(v: unknown): string[] {
  if (typeof v !== "string" || !v) return [];
  try {
    const p = JSON.parse(v);
    return Array.isArray(p) ? p.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
}

export async function getCatalogue(accountId: string, id: string) {
  const c = await db();
  const metaRs = await c.execute({
    sql: `SELECT id, name, created_at, updated_at, dataset_revision, assumptions_json,
                 totals_complete, calculated_at, mpf
            FROM catalogue WHERE id = ? AND account_id = ?`,
    args: [id, accountId],
  });
  const m = metaRs.rows[0] as unknown as
    (Omit<CatalogueMeta, "assumptions"> & { assumptions_json: string | null }) | undefined;
  if (!m) return null;
  const { assumptions_json, ...rest } = m;
  const meta: CatalogueMeta = { ...rest, assumptions: jsonList(assumptions_json) };

  const itemsRs = await c.execute({
    sql: "SELECT * FROM catalogue_item WHERE catalogue_id = ? ORDER BY row_number IS NULL, row_number, rowid",
    args: [id],
  });
  const items = (itemsRs.rows as unknown as
    (Omit<CatalogueItem, "review" | "warnings" | "incomplete"> &
      { review_json: string | null; warnings_json: string | null; incomplete_json: string | null })[])
    .map(({ review_json, warnings_json, incomplete_json, ...it }) => ({
      ...it,
      review: jsonList(review_json),
      warnings: jsonList(warnings_json),
      incomplete: jsonList(incomplete_json),
    })) as CatalogueItem[];
  return { ...meta, items };
}

/** Whether a saved line needs attention. A row saved before statuses existed
 *  can only say whether a trade-remedy scope was unverified. */
export const itemUnresolved = (i: Pick<CatalogueItem, "status" | "scope_unverified">): boolean =>
  i.status === null ? i.scope_unverified > 0 : i.status !== "ready";

/** Figures for a saved catalogue, from its stored lines. Only priced lines (or
 *  a legacy row, which never recorded a status) carry numbers. */
export function catalogueTotals(items: CatalogueItem[], mpf: number | null) {
  return totalsOf(
    items.map((i) => ({
      status: (i.status ?? "ready") as Status,
      entered_value: i.value ?? 0,
      duty: i.duty ?? 0,
      refundable: i.refundable ?? 0,
    })),
    mpf ?? 0,
  );
}

export async function deleteCatalogue(accountId: string, id: string): Promise<boolean> {
  const rs = await (await db()).execute({
    sql: "DELETE FROM catalogue WHERE id = ? AND account_id = ?",
    args: [id, accountId],
  });
  return rs.rowsAffected > 0;
}

/** Codes deleting this catalogue would stop watching: the ones it added, and
 *  only those, so a code also watched from its own page is not counted. */
export async function countCatalogueWatches(accountId: string, id: string): Promise<number> {
  const rs = await (await db()).execute({
    sql: "SELECT count(*) AS n FROM watched_code WHERE account_id = ? AND catalogue_id = ?",
    args: [accountId, id],
  });
  return (rs.rows[0] as unknown as { n: number }).n;
}

export async function countCatalogueItems(accountId: string): Promise<number> {
  const rs = await (await db()).execute({
    sql: `SELECT count(*) AS n FROM catalogue_item i
            JOIN catalogue c ON c.id = i.catalogue_id
           WHERE c.account_id = ?`,
    args: [accountId],
  });
  return (rs.rows[0] as unknown as { n: number }).n;
}

/** A code watched on its own, from a code page rather than a catalogue. */
export async function watchCode(accountId: string, hts: string): Promise<void> {
  await (await db()).execute({
    sql: `INSERT OR IGNORE INTO watched_code(account_id, digits, hts, catalogue_id, created_at)
          VALUES(?,?,?,NULL,?)`,
    args: [accountId, hts.replace(/\./g, ""), hts, new Date().toISOString()],
  });
}

export async function unwatchCode(accountId: string, hts: string): Promise<void> {
  await (await db()).execute({
    sql: "DELETE FROM watched_code WHERE account_id = ? AND digits = ? AND catalogue_id IS NULL",
    args: [accountId, hts.replace(/\./g, "")],
  });
}

export async function isWatched(accountId: string, hts: string): Promise<boolean> {
  const rs = await (await db()).execute({
    sql: "SELECT 1 AS x FROM watched_code WHERE account_id = ? AND digits = ? LIMIT 1",
    args: [accountId, hts.replace(/\./g, "")],
  });
  return rs.rows.length > 0;
}

export async function listWatched(accountId: string) {
  const rs = await (await db()).execute({
    sql: `SELECT w.hts, w.digits, w.created_at, c.name AS catalogue_name, w.catalogue_id
            FROM watched_code w
            LEFT JOIN catalogue c ON c.id = w.catalogue_id
           WHERE w.account_id = ?
           ORDER BY w.hts`,
    args: [accountId],
  });
  return rs.rows as unknown as {
    hts: string; digits: string; created_at: string;
    catalogue_name: string | null; catalogue_id: string | null;
  }[];
}
