import type { CatalogueItem } from "@/lib/catalogues";

/** Explains the human review state of a catalogue. The counts are on the
 *  review page's filter tabs, and actions happen there too, reached from the
 *  header's primary button. A calculation is not a sign-off, so say so here. */
export default function ReviewWorkspace({ items }: { items: Pick<CatalogueItem, "review_status">[] }) {
  return (
    <section className="panel space-y-2 p-5" aria-label="Human review">
      <h2 className="serif text-xl">Human review</h2>
      <p className="text-[13px] text-muted">
        A calculation is not a sign-off. Approve, request changes, reject or assign each of the{" "}
        {items.length.toLocaleString()} lines separately from what the engine computed.
      </p>
    </section>
  );
}
