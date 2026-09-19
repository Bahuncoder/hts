import { Badge } from "@/components/ui";
import { LEGACY_LABEL, STATUS_LABEL, bucketOf, type Bucket, type Status } from "@/lib/auditModel";

const TONE: Record<Bucket, "good" | "warn" | "bad"> = { ready: "good", review: "warn", failed: "bad" };

/** A line's state, in words. Colour reinforces it and never carries it. A
 *  null status is a row saved before statuses were recorded. */
export function StatusChip({ status }: { status: Status | null }) {
  if (status === null) return <Badge tone="neutral">{LEGACY_LABEL}</Badge>;
  return <Badge tone={TONE[bucketOf(status)]}>{STATUS_LABEL[status]}</Badge>;
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
