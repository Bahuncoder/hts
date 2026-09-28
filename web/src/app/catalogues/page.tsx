import { PageHeader } from "@/components/PageHeader";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentViewer } from "@/lib/auth";
import { countCatalogueWatches, listCatalogues } from "@/lib/catalogues";
import { deleteCatalogueAction } from "@/lib/actions";
import { money } from "@/lib/api";
import { Card } from "@/components/ui";
import { PartialMark } from "@/components/status";

export const metadata = { title: "Catalogues" };
export const dynamic = "force-dynamic";

export default async function CataloguesPage({
  searchParams,
}: {
  searchParams: Promise<{ delete?: string }>;
}) {
  const viewer = await currentViewer();
  if (!viewer) redirect("/login");
  const catalogues = await listCatalogues(viewer.account.id);

  // Deleting is a two-step, no-script flow: the Delete link only asks (GET,
  // changes nothing); the form on the confirmation panel is what deletes.
  const { delete: pending } = await searchParams;
  const doomed = pending ? catalogues.find((c) => c.id === pending) : undefined;
  const doomedWatches = doomed ? await countCatalogueWatches(viewer.account.id, doomed.id) : 0;

  return (
    <div className="space-y-7">
      <PageHeader eyebrow="Your saved workspace" title="Catalogues" description="Keep your reviewed estimates in one place. Priced codes are watched for tariff actions, with new matches available in your alerts.">
        <Link href="/audit" className="btn btn-primary">Audit a catalogue <span aria-hidden="true">＋</span></Link>
      </PageHeader>

      {doomed ? (
        <div
          role="alertdialog"
          aria-labelledby="delete-title"
          aria-describedby="delete-body"
          className="space-y-3 rounded-lg border-2 p-5 border-danger bg-surface"
        >
          <h2 id="delete-title" className="text-[17px] font-semibold">
            Delete &ldquo;{doomed.name}&rdquo;?
          </h2>
          <p id="delete-body" className="text-[14px] text-muted">
            This removes the catalogue and its {doomed.items.toLocaleString()} saved{" "}
            {doomed.items === 1 ? "line" : "lines"}, and it also stops watching the{" "}
            {doomedWatches.toLocaleString()} {doomedWatches === 1 ? "code" : "codes"} it added, so you will no
            longer be told when a tariff action names them. Codes you watch on their own from a code page are
            kept. This cannot be undone.
          </p>
          <div className="flex flex-wrap gap-3">
            <form action={deleteCatalogueAction}>
              <input type="hidden" name="id" value={doomed.id} />
              <button
                autoFocus
                className="btn bg-danger text-on-accent hover:brightness-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-danger"
              >
                Delete catalogue and stop watching its codes
              </button>
            </form>
            <Link href="/catalogues" className="btn btn-secondary">
              Keep it
            </Link>
          </div>
        </div>
      ) : null}

      {catalogues.length === 0 ? (
        <div className="panel px-6 py-14 text-center">
          <p className="eyebrow">Make room for your first catalogue</p>
          <h2 className="serif mt-3 text-3xl tracking-tight">Your products. One clear view.</h2>
          <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-muted">Upload your product list, review the results, and save your catalogue here. Codes with a price will be watched for relevant tariff actions.</p>
          <Link href="/audit" className="btn btn-primary mt-6">Start a catalogue audit <span aria-hidden="true">→</span></Link>
        </div>
      ) : (
        <div className="space-y-3">
          {catalogues.map((c) => (
            <Card key={c.id}>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="space-y-1">
                  <Link
                    href={`/catalogues/${c.id}`}
                    className="text-[17px] font-semibold hover:underline"
                  >
                    {c.name}
                  </Link>
                  <div className="text-[13px] text-faint">
                    {c.items.toLocaleString()} products · saved{" "}
                    <span className="nb">
                      {new Date(c.created_at).toLocaleDateString("en-US", {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                      })}
                    </span>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-6 text-right">
                  <div>
                    <div className="lbl">Value</div>
                    <div className="mono text-[16px]">{money(c.value)}</div>
                  </div>
                  <div>
                    <div className="lbl">Duty and fees</div>
                    <div className="mono text-[16px]">{money(c.duty + (c.mpf ?? 0))}</div>
                    {c.totals_complete === 0 ? (
                      <div className="mt-1"><PartialMark unresolved={c.needs_review} /></div>
                    ) : null}
                  </div>
                  <div>
                    <div className="lbl">Needs review</div>
                    <div className="mono text-[16px]">{c.needs_review.toLocaleString()}</div>
                  </div>
                  {c.refundable > 0 ? (
                    <div>
                      <div className="lbl text-recover">Refundable</div>
                      <div className="mono text-[16px] text-recover">
                        {money(c.refundable)}
                      </div>
                    </div>
                  ) : null}
                  <Link
                    href={`/catalogues?delete=${c.id}`}
                    className="rounded-(--radius-control) border border-rule px-2.5 py-1.5 text-[13px] text-muted transition-colors hover:border-faint hover:bg-sunk"
                  >
                    Delete<span className="sr-only"> {c.name}</span>
                  </Link>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
