/** API/report adapter over the existing review workflow: one state and one
 * append-only history serve both review screens and every export. */
import { ensureReviews, setApproval, addComment } from "./review";
import { REVIEW_ACTIONS, MAX_REVIEW_NOTE, type ReviewAction, type ReviewEvent } from "./reviewModel";
export type { ReviewAction } from "./reviewModel";
export class ReviewValidationError extends Error {}
export async function listReviews(accountId: string, catalogueId: string): Promise<ReviewEvent[]> {
  const result = await (await ensureReviews()).execute({ sql: `SELECT e.id,e.item_id,e.account_id AS actor_id,e.actor AS actor_email,
      CASE WHEN e.kind = 'approval' THEN CASE e.approval_status WHEN 'approved' THEN 'approve' WHEN 'pending' THEN 'reopen' WHEN 'rejected' THEN 'reject' ELSE 'needs_review' END ELSE e.kind END AS action,
      e.approval_status AS status,e.comment AS note,e.created_at AS at,e.version,e.assigned_to
      FROM catalogue_item_event e JOIN catalogue_item i ON i.id = e.item_id JOIN catalogue c ON c.id = i.catalogue_id
      WHERE c.account_id = ? AND c.id = ? ORDER BY e.created_at,e.rowid`, args: [accountId, catalogueId] });
  return result.rows as unknown as ReviewEvent[];
}
export async function recordReview(accountId: string, email: string, input: { catalogueId: string; itemId: string; action: ReviewAction; note: string; version: number }): Promise<boolean> {
  if (!REVIEW_ACTIONS.some((a) => a.value === input.action) || typeof input.note !== "string" || !input.note.trim() || input.note.length > MAX_REVIEW_NOTE || !Number.isSafeInteger(input.version) || input.version < 0) throw new ReviewValidationError("Select an action and enter a review note (1–2,000 characters).");
  const c = await ensureReviews();
  const owned = await c.execute({ sql: "SELECT i.id FROM catalogue_item i JOIN catalogue c ON c.id = i.catalogue_id WHERE c.account_id = ? AND c.id = ? AND i.id = ?", args: [accountId, input.catalogueId, input.itemId] });
  if (!owned.rows.length) return false;
  if (input.action === "comment") return addComment(accountId, email, input.itemId, input.note, input.version);
  return setApproval(accountId, email, input.itemId, input.action === "approve" ? "approved" : input.action === "needs_review" ? "changes_requested" : "pending", input.note, input.version);
}
