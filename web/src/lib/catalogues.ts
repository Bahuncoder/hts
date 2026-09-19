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
export async function saveCatalogue(
  accountId: string, name: string, items: CatalogueItemInput[],
): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const c = await db();
  const tx = await c.transaction("write");

  try {
    await tx.execute({
      sql: "INSERT INTO catalogue(id, account_id, name, created_at, updated_at) VALUES(?,?,?,?,?)",
      args: [id, accountId, name, now, now],
    });

    for (const it of items) {
      const digits = digitsOf(it.hts);
      await tx.execute({
        sql: `INSERT INTO catalogue_item(id, catalogue_id, sku, description, country, value,
                hts, digits, confidence, duty, effective_rate, refundable, scope_unverified)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        args: [
          crypto.randomUUID(), id, it.sku ?? null, it.description, it.country, it.value,
          it.hts ?? null, digits, it.confidence ?? null,
          it.duty ?? null, it.effective_rate_pct ?? null, it.refundable ?? null,
          it.scope_unverified?.length ? 1 : 0,
        ],
      });
      if (digits && it.hts) {
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
    sql: `SELECT c.id, c.name, c.created_at, c.updated_at,
                 count(i.id)                       AS items,
                 COALESCE(sum(i.value), 0)         AS value,
                 COALESCE(sum(i.duty), 0)          AS duty,
                 COALESCE(sum(i.refundable), 0)    AS refundable,
                 COALESCE(sum(i.scope_unverified), 0) AS flagged
            FROM catalogue c
            LEFT JOIN catalogue_item i ON i.catalogue_id = c.id
           WHERE c.account_id = ?
           GROUP BY c.id
           ORDER BY c.updated_at DESC`,
    args: [accountId],
  });
  return rs.rows as unknown as CatalogueSummary[];
}

export async function getCatalogue(accountId: string, id: string) {
  const c = await db();
  const metaRs = await c.execute({
    sql: "SELECT id, name, created_at, updated_at FROM catalogue WHERE id = ? AND account_id = ?",
    args: [id, accountId],
  });
  const meta = metaRs.rows[0] as unknown as
    { id: string; name: string; created_at: string; updated_at: string } | undefined;
  if (!meta) return null;
  const itemsRs = await c.execute({
    sql: "SELECT * FROM catalogue_item WHERE catalogue_id = ? ORDER BY rowid",
    args: [id],
  });
  return { ...meta, items: itemsRs.rows as unknown as CatalogueItem[] };
}

export async function deleteCatalogue(accountId: string, id: string): Promise<boolean> {
  const rs = await (await db()).execute({
    sql: "DELETE FROM catalogue WHERE id = ? AND account_id = ?",
    args: [id, accountId],
  });
  return rs.rowsAffected > 0;
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
