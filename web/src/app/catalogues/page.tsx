import Link from "next/link";
import { redirect } from "next/navigation";
import { currentViewer } from "@/lib/auth";
import { listCatalogues } from "@/lib/catalogues";
import { deleteCatalogueAction } from "@/lib/actions";
import { money } from "@/lib/api";
import { Card } from "@/components/ui";

export const metadata = { title: "Catalogues" };
export const dynamic = "force-dynamic";

export default async function CataloguesPage() {
  const viewer = await currentViewer();
  if (!viewer) redirect("/login");
  const catalogues = listCatalogues(viewer.account.id);

  return (
    <div className="space-y-7">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1.5">
          <h1 className="serif text-3xl tracking-tight">Catalogues</h1>
          <p className="text-[15px] text-muted">
            Every code in a saved catalogue is watched. When a tariff action
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
                    <div className="lbl">Duty</div>
                    <div className="mono text-[16px]">{money(c.duty)}</div>
                  </div>
                  {c.refundable > 0 ? (
                    <div>
                      <div className="lbl text-recover">Refundable</div>
                      <div className="mono text-[16px] text-recover">
                        {money(c.refundable)}
                      </div>
                    </div>
                  ) : null}
                  <form action={deleteCatalogueAction}>
                    <input type="hidden" name="id" value={c.id} />
                    <button className="px-2.5 py-1.5 text-[13px] border border-rule text-muted">
                      Delete
                    </button>
                  </form>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
