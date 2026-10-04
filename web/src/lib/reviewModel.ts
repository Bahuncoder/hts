// The vocabulary listReviews() (lib/reviews.ts) has always reported evidence
// history in -- kept independent of lib/review.ts's own ApprovalStatus enum
// so the exported evidence format never changes shape when the write side does.
export type ReviewAction = "comment" | "approve" | "needs_review" | "reopen" | "correction";
export const MAX_REVIEW_NOTE = 2000;
export const MAX_REVIEW_EVENTS = 1000;
export type ReviewEvent = { id: string; item_id: string; actor_id: string; actor_email: string; action: ReviewAction | "reject" | "assignment"; status: string | null; note: string | null; at: string; version: number | null; assigned_to: string | null };
