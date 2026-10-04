import crypto from "node:crypto";
import type { Client } from "@libsql/client";
import { db, addColumns } from "./store";
import { MAX_REVIEW_EVENTS, MAX_REVIEW_NOTE } from "./reviewModel";

/** Human review of a saved catalogue line: an approval decision, an
 *  assignment, and comments — kept apart from the engine's own `status`
 *  (auditModel.ts), which describes what was computed, not who signed off on
 *  it. A saved catalogue's evidence export says as much: approval here is a
 *  fact about this product, not a substitute for a customs broker's review.
 *
 *  This module owns its own schema (`ensureSchema` below) rather than adding
 *  to store.ts's central migration list, so the feature is one self-contained
 *  unit: everything it needs is created the first time it is used, and nothing
 *  elsewhere has to know about it to keep working.
 */

export type ApprovalStatus = "pending" | "approved" | "changes_requested" | "rejected";
export const APPROVAL_STATUSES: readonly ApprovalStatus[] =
  ["pending", "approved", "changes_requested", "rejected"];
/** The human review state, named the same way everywhere. It is separate from
 *  the estimate state (Estimate: Complete / Needs information). */
export const APPROVAL_LABEL: Record<ApprovalStatus, string> = {
  pending: "Review: Pending",
  approved: "Review: Approved",
  changes_requested: "Review: Changes requested",
  rejected: "Review: Rejected",
};
export const isApprovalStatus = (v: unknown): v is ApprovalStatus =>
  typeof v === "string" && (APPROVAL_STATUSES as readonly string[]).includes(v);

export type ReviewEvent = {
  id: string;
  kind: "comment" | "approval" | "assignment" | "correction";
  actor: string;
  approval_status: ApprovalStatus | null;
  assigned_to: string | null;
  comment: string | null;
  created_at: string;
};

const MAX_COMMENT = MAX_REVIEW_NOTE;
const MAX_ASSIGNEE = 200;

let ready: Promise<void> | null = null;

async function ensureSchema(c: Client): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await c.execute(`
        CREATE TABLE IF NOT EXISTS catalogue_item_event (
          id              TEXT PRIMARY KEY,
          item_id         TEXT NOT NULL REFERENCES catalogue_item(id) ON DELETE CASCADE,
          account_id      TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
          kind            TEXT NOT NULL,
          actor           TEXT NOT NULL,
          approval_status TEXT,
          assigned_to     TEXT,
          comment         TEXT,
          created_at      TEXT NOT NULL
        )
      `);
      await c.execute(
        "CREATE INDEX IF NOT EXISTS item_event_item ON catalogue_item_event(item_id, created_at)");
      await addColumns(c, "catalogue_item", { approval_status: "TEXT NOT NULL DEFAULT 'pending'", assigned_to: "TEXT" });
      await addColumns(c, "catalogue_item_event", { version: "INTEGER" });
    })().catch((error) => { ready = null; throw error; });
  }
  await ready;
}

export async function ensureReviews(): Promise<Client> {
  const c = await db();
  await ensureSchema(c);
  return c;
}
const conn = ensureReviews;

/** The account that owns the catalogue this item belongs to, or null if the
 *  item does not exist or belongs to someone else. Every function below
 *  checks this before reading or writing anything, the same way the rest of
 *  the account-scoped store does. */
async function ownedItem(
  c: Client, accountId: string, itemId: string,
): Promise<{ id: string; catalogue_id: string; review_version: number } | null> {
  const rs = await c.execute({
    sql: `SELECT ci.id, ci.catalogue_id, ci.review_version FROM catalogue_item ci
            JOIN catalogue ON catalogue.id = ci.catalogue_id
          WHERE ci.id = ? AND catalogue.account_id = ?`,
    args: [itemId, accountId],
  });
  return (rs.rows[0] as unknown as { id: string; catalogue_id: string; review_version: number } | undefined) ?? null;
}

async function commitReview(c: Client, args: {
  itemId: string; accountId: string; kind: ReviewEvent["kind"]; actor: string;
  approvalStatus?: ApprovalStatus | null; assignedTo?: string | null; comment?: string | null;
  version: number;
}): Promise<boolean> {
  const id = crypto.randomUUID(), now = new Date().toISOString();
  const result = await c.batch([
    { sql: `UPDATE catalogue_item SET review_version = review_version + 1,
        approval_status = CASE WHEN ? = 'approval' THEN ? ELSE approval_status END,
        assigned_to = CASE WHEN ? = 'assignment' THEN ? ELSE assigned_to END
      WHERE id = ? AND review_version = ?
        AND catalogue_id IN (SELECT id FROM catalogue WHERE account_id = ?)
        AND (? <> 'approved' OR (hts IS NOT NULL AND status IN ('ready','scope_review','suffix_review','low_confidence') AND duty IS NOT NULL))
        AND (SELECT count(*) FROM catalogue_item_event e JOIN catalogue_item i ON i.id = e.item_id WHERE i.catalogue_id = catalogue_item.catalogue_id) < ?`,
      args: [args.kind, args.approvalStatus ?? null, args.kind, args.assignedTo ?? null, args.itemId, args.version, args.accountId, args.approvalStatus ?? "", MAX_REVIEW_EVENTS] },
    { sql: `INSERT INTO catalogue_item_event(id,item_id,account_id,kind,actor,approval_status,assigned_to,comment,created_at,version)
        SELECT ?,id,?,?,?,approval_status,?,?,?,review_version FROM catalogue_item WHERE id = ? AND changes() = 1`,
      args: [id, args.accountId, args.kind, args.actor, args.assignedTo ?? null, args.comment ?? null, now, args.itemId] },
    { sql: "UPDATE catalogue SET updated_at = ? WHERE id IN (SELECT catalogue_id FROM catalogue_item WHERE id = ?) AND EXISTS(SELECT 1 FROM catalogue_item_event WHERE id = ?)", args: [now, args.itemId, id] },
  ], "write");
  return result[0].rowsAffected === 1;
}

/** Records an approval decision, replacing the item's current one. An
 *  optional note is recorded on the same event ("Approved — looks right for
 *  the new supplier"), not as a second, separate comment. */
export async function setApproval(
  accountId: string, actor: string, itemId: string, status: ApprovalStatus, note?: string, version?: number,
): Promise<boolean> {
  if (!isApprovalStatus(status)) throw new Error("Invalid approval status.");
  const c = await conn();
  const item = await ownedItem(c, accountId, itemId);
  if (!item) return false;
  if ((note ?? "").length > MAX_REVIEW_NOTE) throw new Error("Review note is too long.");
  const comment = (note ?? "").trim() || `Marked ${APPROVAL_LABEL[status]}`;
  return commitReview(c, { itemId, accountId, kind: "approval", actor, approvalStatus: status, comment, version: version ?? item.review_version });
}

/** Sets (or, with an empty string, clears) who a line is assigned to. A free
 *  name or email: there is no team roster to pick from yet, so this is a note
 *  about who is responsible, not a login the app checks against. */
export async function assignItem(
  accountId: string, actor: string, itemId: string, assignee: string, version?: number,
): Promise<boolean> {
  const c = await conn();
  const item = await ownedItem(c, accountId, itemId);
  if (!item) return false;
  const clean = assignee.trim().slice(0, MAX_ASSIGNEE);
  return commitReview(c, { itemId, accountId, kind: "assignment", actor, assignedTo: clean || null, version: version ?? item.review_version });
}

/** Adds a comment without changing approval or assignment. Returns false for
 *  an item that does not exist or is not this account's; throws for empty
 *  text, which is a caller mistake rather than an authorization question. */
export async function addComment(
  accountId: string, actor: string, itemId: string, text: string, version?: number,
): Promise<boolean> {
  const clean = text.trim().slice(0, MAX_COMMENT);
  if (!clean) throw new Error("Enter a comment.");
  const c = await conn();
  const item = await ownedItem(c, accountId, itemId);
  if (!item) return false;
  return commitReview(c, { itemId, accountId, kind: "comment", actor, comment: clean, version: version ?? item.review_version });
}

/** Every event recorded against a line, oldest first — the comment thread and
 *  the approval/assignment history in one feed, the way they happened. */
export async function itemHistory(accountId: string, itemId: string): Promise<ReviewEvent[]> {
  const c = await conn();
  const item = await ownedItem(c, accountId, itemId);
  if (!item) return [];
  const rs = await c.execute({
    sql: `SELECT id, kind, actor, approval_status, assigned_to, comment, created_at
            FROM catalogue_item_event WHERE item_id = ? ORDER BY created_at ASC`,
    args: [itemId],
  });
  return rs.rows as unknown as ReviewEvent[];
}

export type ItemReviewState = { id: string; approval_status: ApprovalStatus; assigned_to: string | null };

/** The current approval state of every item in a catalogue, for a listing
 *  that does not want to run one query per row. Ownership is enforced by the
 *  join: an id from a different account's catalogue returns nothing. */
export async function catalogueReviewState(
  accountId: string, catalogueId: string,
): Promise<Map<string, ItemReviewState>> {
  const c = await conn();
  const rs = await c.execute({
    sql: `SELECT ci.id, ci.approval_status, ci.assigned_to FROM catalogue_item ci
            JOIN catalogue ON catalogue.id = ci.catalogue_id
          WHERE ci.catalogue_id = ? AND catalogue.account_id = ?`,
    args: [catalogueId, accountId],
  });
  const out = new Map<string, ItemReviewState>();
  for (const row of rs.rows as unknown as { id: string; approval_status: string; assigned_to: string | null }[]) {
    out.set(row.id, {
      id: row.id,
      approval_status: isApprovalStatus(row.approval_status) ? row.approval_status : "pending",
      assigned_to: row.assigned_to,
    });
  }
  return out;
}

/** How many of a catalogue's items are in each approval state, for a summary
 *  line ("3 approved, 1 changes requested, 12 pending"). */
export function approvalCounts(items: Iterable<{ approval_status: ApprovalStatus }>): Record<ApprovalStatus, number> {
  const out: Record<ApprovalStatus, number> = { pending: 0, approved: 0, changes_requested: 0, rejected: 0 };
  for (const item of items) out[item.approval_status] += 1;
  return out;
}

/** The catalogue to open from the Review link: the most recently changed one
 *  that still has a line waiting for a decision. Null when nothing is waiting. */
export async function nextReviewCatalogue(accountId: string): Promise<{ id: string; pending: number } | null> {
  const c = await conn();
  const rs = await c.execute({
    sql: `SELECT c.id, count(i.id) AS pending
            FROM catalogue c
            JOIN catalogue_item i ON i.catalogue_id = c.id
           WHERE c.account_id = ? AND i.approval_status = 'pending'
           GROUP BY c.id
           ORDER BY c.updated_at DESC
           LIMIT 1`,
    args: [accountId],
  });
  const row = rs.rows[0];
  return row ? { id: String(row.id), pending: Number(row.pending) } : null;
}
