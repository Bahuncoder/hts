export const REVIEW_ACTIONS = [
  { value: "comment", label: "Add a comment" }, { value: "approve", label: "Approve classification" },
  { value: "needs_review", label: "Request further review" }, { value: "reopen", label: "Reopen review" },
] as const;
export type ReviewAction = typeof REVIEW_ACTIONS[number]["value"];
export const MAX_REVIEW_NOTE = 2000;
export const MAX_REVIEW_EVENTS = 1000;
export type ReviewEvent = { id: string; item_id: string; actor_id: string; actor_email: string; action: ReviewAction | "reject" | "assignment"; status: string | null; note: string | null; at: string; version: number | null; assigned_to: string | null };
