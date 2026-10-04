import { Badge } from "@/components/ui";
import { LEGACY_LABEL, STATUS_LABEL, bucketOf, type Bucket, type Status } from "@/lib/auditModel";

const TONE: Record<Bucket, "good" | "warn" | "bad"> = { ready: "good", review: "warn", failed: "bad" };

/** The estimate, in two names only: a line is complete or it needs
 *  information. Human review is a separate state (see APPROVAL_LABEL). */
export const ESTIMATE_LABEL: Record<Bucket, string> = {
  ready: "Estimate: Complete",
  review: "Estimate: Needs information",
  failed: "Estimate: Needs information",
};

/** A line's estimate state, with the specific reason beneath it. Colour
 *  reinforces the words and never carries them. A null status is a row saved
 *  before statuses were recorded. */
export function StatusChip({ status }: { status: Status | null }) {
  if (status === null) return <Badge tone="neutral">{LEGACY_LABEL}</Badge>;
  const bucket = bucketOf(status);
  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      <Badge tone={TONE[bucket]}>{ESTIMATE_LABEL[bucket]}</Badge>
      <span className="text-[12px] text-muted">{STATUS_LABEL[status]}</span>
    </span>
  );
}

/** A total that leaves lines out must say so beside the amount, not in a
 *  footnote: a partial figure that reads as complete understates exposure. */
export function PartialMark({ unresolved }: { unresolved: number }) {
  return (
    <span
      className="inline-block rounded border px-1.5 py-0.5 text-[11px] font-medium border-caution bg-caution-soft text-caution-ink"
      title="These figures leave out, or do not yet stand behind, the unresolved lines."
    >
      Partial: {unresolved.toLocaleString()} {unresolved === 1 ? "line" : "lines"} unresolved
    </span>
  );
}
