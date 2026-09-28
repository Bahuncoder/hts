/** Report/export adapter over the existing review workflow: one append-only
 * history feeds both the evidence export and the printable report. Actions
 * are recorded in exactly one place (lib/review.ts, driven by the /review
 * page's Server Actions) and read back here in the vocabulary the exported
 * evidence has always used. */
import { ensureReviews } from "./review";
import type { ReviewEvent } from "./reviewModel";
export async function listReviews(accountId: string, catalogueId: string): Promise<ReviewEvent[]> {
  const result = await (await ensureReviews()).execute({ sql: `SELECT e.id,e.item_id,e.account_id AS actor_id,e.actor AS actor_email,
      CASE WHEN e.kind = 'approval' THEN CASE e.approval_status WHEN 'approved' THEN 'approve' WHEN 'pending' THEN 'reopen' WHEN 'rejected' THEN 'reject' ELSE 'needs_review' END ELSE e.kind END AS action,
      e.approval_status AS status,e.comment AS note,e.created_at AS at,e.version,e.assigned_to
      FROM catalogue_item_event e JOIN catalogue_item i ON i.id = e.item_id JOIN catalogue c ON c.id = i.catalogue_id
      WHERE c.account_id = ? AND c.id = ? ORDER BY e.created_at,e.rowid`, args: [accountId, catalogueId] });
  return result.rows as unknown as ReviewEvent[];
}
