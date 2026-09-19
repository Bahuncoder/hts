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
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1.5">
          <h1 className="serif text-3xl tracking-tight">Catalogues</h1>
          <p className="text-[15px] text-muted">
            Every priced code in a saved catalogue is watched. When a tariff action
            names one, it lands in{" "}
            <Link href="/alerts" className="hover:underline text-accent">
              your alerts
            </Link>
            .
          </p>
        </div>
        <Link
          href="/audit"
          className="px-4 py-2 text-[14px] font-medium bg-accent text-on-accent"
        >
          Audit a catalogue
        </Link>
      </div>

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
                className="px-4 py-2 text-[14px] font-medium bg-danger text-on-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-danger"
              >
                Delete catalogue and stop watching its codes
              </button>
            </form>
            <Link href="/catalogues" className="px-4 py-2 text-[14px] font-medium border border-rule">
              Keep it
            </Link>
          </div>
        </div>
      ) : null}

      {catalogues.length === 0 ? (
        <Card>
          <p className="text-[15px] text-muted">
            Nothing saved yet. Run an audit and save the result — that is what
            turns a one-off calculation into something we can watch for you.
          </p>
        </Card>
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
                    className="px-2.5 py-1.5 text-[13px] border border-rule text-muted"
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
