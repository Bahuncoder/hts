import crypto from "node:crypto";
import { db } from "./store";

export type CatalogueItemInput = {
  sku?: string;
  description: string;
  country: string;
  value: number;
  hts?: string | null;
  confidence?: string;
  duty?: number;
  effective_rate_pct?: number;
  refundable?: number;
  scope_unverified?: string[];
};

export type CatalogueSummary = {
  id: string; name: string; created_at: string; updated_at: string;
  items: number; value: number; duty: number; refundable: number; flagged: number;
};

export type CatalogueItem = {
  id: string; sku: string | null; description: string; country: string;
  value: number; hts: string | null; digits: string | null;
  confidence: string | null; duty: number | null; effective_rate: number | null;
  refundable: number | null; scope_unverified: number;
};

const digitsOf = (hts?: string | null) => (hts ? hts.replace(/\./g, "") : null);

/** Saves a catalogue and watches every code in it.
 *
 *  Watching is not a separate opt-in: a saved catalogue exists so we can tell
 *  the customer when something moves under it. Codes are recorded against the
 *  catalogue so deleting it withdraws exactly the watches it created and
 *  leaves any standalone ones alone.
 */
export function saveCatalogue(
  accountId: string, name: string, items: CatalogueItemInput[],
): string {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const d = db();

  d.transaction(() => {
    d.prepare("INSERT INTO catalogue(id, account_id, name, created_at, updated_at) VALUES(?,?,?,?,?)")
      .run(id, accountId, name, now, now);

    const insItem = d.prepare(`
      INSERT INTO catalogue_item(id, catalogue_id, sku, description, country, value,
        hts, digits, confidence, duty, effective_rate, refundable, scope_unverified)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insWatch = d.prepare(`
      INSERT OR IGNORE INTO watched_code(account_id, digits, hts, catalogue_id, created_at)
      VALUES(?,?,?,?,?)`);

    for (const it of items) {
      const digits = digitsOf(it.hts);
      insItem.run(
        crypto.randomUUID(), id, it.sku ?? null, it.description, it.country, it.value,
        it.hts ?? null, digits, it.confidence ?? null,
        it.duty ?? null, it.effective_rate_pct ?? null, it.refundable ?? null,
        it.scope_unverified?.length ? 1 : 0,
      );
      if (digits && it.hts) insWatch.run(accountId, digits, it.hts, id, now);
    }
  })();

  return id;
}

export function listCatalogues(accountId: string): CatalogueSummary[] {
  return db().prepare(`
    SELECT c.id, c.name, c.created_at, c.updated_at,
           count(i.id)                       AS items,
           COALESCE(sum(i.value), 0)         AS value,
           COALESCE(sum(i.duty), 0)          AS duty,
           COALESCE(sum(i.refundable), 0)    AS refundable,
           COALESCE(sum(i.scope_unverified), 0) AS flagged
      FROM catalogue c
      LEFT JOIN catalogue_item i ON i.catalogue_id = c.id
     WHERE c.account_id = ?
     GROUP BY c.id
     ORDER BY c.updated_at DESC`).all(accountId) as CatalogueSummary[];
}

export function getCatalogue(accountId: string, id: string) {
  const meta = db().prepare(
    "SELECT id, name, created_at, updated_at FROM catalogue WHERE id = ? AND account_id = ?"
  ).get(id, accountId) as { id: string; name: string; created_at: string; updated_at: string } | undefined;
  if (!meta) return null;
  const items = db().prepare(
    "SELECT * FROM catalogue_item WHERE catalogue_id = ? ORDER BY rowid"
  ).all(id) as CatalogueItem[];
  return { ...meta, items };
}

export function deleteCatalogue(accountId: string, id: string): boolean {
  const res = db().prepare("DELETE FROM catalogue WHERE id = ? AND account_id = ?")
    .run(id, accountId);
  return res.changes > 0;
}

export function countCatalogueItems(accountId: string): number {
  const row = db().prepare(`
    SELECT count(*) AS n FROM catalogue_item i
      JOIN catalogue c ON c.id = i.catalogue_id
     WHERE c.account_id = ?`).get(accountId) as { n: number };
  return row.n;
}

/** A code watched on its own, from a code page rather than a catalogue. */
export function watchCode(accountId: string, hts: string): void {
  db().prepare(`
    INSERT OR IGNORE INTO watched_code(account_id, digits, hts, catalogue_id, created_at)
    VALUES(?,?,?,NULL,?)`)
    .run(accountId, hts.replace(/\./g, ""), hts, new Date().toISOString());
}

export function unwatchCode(accountId: string, hts: string): void {
  db().prepare(
    "DELETE FROM watched_code WHERE account_id = ? AND digits = ? AND catalogue_id IS NULL"
  ).run(accountId, hts.replace(/\./g, ""));
}

export function isWatched(accountId: string, hts: string): boolean {
  const row = db().prepare(
    "SELECT 1 AS x FROM watched_code WHERE account_id = ? AND digits = ? LIMIT 1"
  ).get(accountId, hts.replace(/\./g, "")) as { x: number } | undefined;
  return Boolean(row);
}

export function listWatched(accountId: string) {
  return db().prepare(`
    SELECT w.hts, w.digits, w.created_at, c.name AS catalogue_name, w.catalogue_id
      FROM watched_code w
      LEFT JOIN catalogue c ON c.id = w.catalogue_id
     WHERE w.account_id = ?
     ORDER BY w.hts`).all(accountId) as {
       hts: string; digits: string; created_at: string;
       catalogue_name: string | null; catalogue_id: string | null;
     }[];
}
