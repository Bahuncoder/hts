import { redirect } from "next/navigation";
import EmptyState from "@/components/EmptyState";
import { requireViewer } from "@/lib/auth";
import { nextReviewCatalogue } from "@/lib/review";

export const metadata = { title: "Review" };
export const dynamic = "force-dynamic";

/** The Review link. A review belongs to one saved catalogue, so this opens
 *  the one with a line waiting for a decision, or says that nothing is. */
export default async function ReviewPage() {
  const viewer = await requireViewer("/review");
  const next = await nextReviewCatalogue(viewer.account.id);
  if (next) redirect(`/catalogues/${next.id}/review?status=pending`);
  return (
    <EmptyState
      title="Nothing is waiting for review"
      action={{ href: "/catalogues", label: "Your catalogues" }}
    >
      <p>
        Every saved line has a decision. A line comes back here when its estimate changes or it is re-priced.
      </p>
    </EmptyState>
  );
}
