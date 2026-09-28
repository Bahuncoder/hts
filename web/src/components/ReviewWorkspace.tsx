import Link from "next/link";
import { APPROVAL_LABEL, APPROVAL_STATUSES, approvalCounts, type ApprovalStatus } from "@/lib/review";
import type { CatalogueItem } from "@/lib/catalogues";

const TONE: Record<ApprovalStatus, string> = {
  pending: "text-muted",
  approved: "text-accent",
  changes_requested: "text-caution-ink",
  rejected: "text-danger",
};

/** A one-line summary of a catalogue's human review state, linking to the one
 *  place review actions happen (approve/request changes/reject, assign,
 *  comment). This used to be a second, smaller review form with its own
 *  vocabulary (no reject, no assignment, a flat unsearchable product picker)
 *  writing through its own API route -- confusing for exactly the feature
 *  meant to produce a clean audit trail, since a reviewer landed on two
 *  different screens with two different label sets for the same four
 *  states. Approving/rejecting/assigning now happens in exactly one place. */
export default function ReviewWorkspace({
  catalogueId, items,
}: { catalogueId: string; items: Pick<CatalogueItem, "review_status">[] }) {
  const counts = approvalCounts(items.map((i) => ({ approval_status: i.review_status })));
  return (
    <section className="panel space-y-3 p-5" aria-label="Human review">
      <h2 className="serif text-xl">Human review</h2>
      <p className="text-[13px] text-muted">
        A calculation is not a sign-off. Approve, request changes, reject or assign each line
        separately from what the engine computed.
      </p>
      <div className="flex flex-wrap gap-3 text-[13px]">
        {APPROVAL_STATUSES.map((s) => (
          <span key={s} className={`rounded-full border border-border px-3 py-1 ${TONE[s]}`}>
            {APPROVAL_LABEL[s]}: {counts[s]}
          </span>
        ))}
      </div>
      <Link href={`/catalogues/${catalogueId}/review`} className="btn btn-secondary">
        Review classifications
      </Link>
    </section>
  );
}
