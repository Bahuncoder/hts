import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { currentViewer } from "@/lib/auth";
import { getCatalogue } from "@/lib/catalogues";
import { money, money2 } from "@/lib/api";
import { Badge, Card, Stat } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function CataloguePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const viewer = await currentViewer();
  if (!viewer) redirect("/login");
  const { id } = await params;
  const cat = getCatalogue(viewer.account.id, id);
  if (!cat) notFound();

  const total = cat.items.reduce((a, i) => a + (i.value ?? 0), 0);
  const duty = cat.items.reduce((a, i) => a + (i.duty ?? 0), 0);
  const refundable = cat.items.reduce((a, i) => a + (i.refundable ?? 0), 0);
  const flagged = cat.items.filter((i) => i.scope_unverified).length;

  return (
    <div className="space-y-7">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1.5">
          <Link
            href="/catalogues"
            className="text-[13px] hover:underline text-faint"
          >
            ← Catalogues
          </Link>
          <h1 className="serif text-3xl tracking-tight">{cat.name}</h1>
          <p className="text-[13px] text-faint">
            {cat.items.length.toLocaleString()} products · every classified code
            is watched
          </p>
        </div>
        <a
          href={`/api/catalogues/export?id=${cat.id}`}
          className="px-4 py-2 text-[14px] font-medium border border-rule"
        >
          Export CSV
        </a>
      </div>

      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <Stat label="Entered value" value={money(total)} />
        </Card>
        <Card>
          <Stat
            label="Duty and fees"
            value={money(duty)}
            sub={
              total
                ? `${((duty / total) * 100).toFixed(2)}% effective`
                : undefined
            }
          />
        </Card>
        <Card>
          <Stat
            label="Potentially refundable"
            value={money(refundable)}
            sub={refundable > 0 ? "IEEPA, struck down" : "none identified"}
            tone={refundable > 0 ? "warn" : undefined}
          />
        </Card>
        <Card>
          <Stat
            label="Needs review"
            value={String(flagged)}
            sub="scope unverified"
          />
        </Card>
      </div>

      <div className="scroll-x">
        <table className="w-full min-w-[820px] text-[14px]">
          <thead>
            <tr className="border-b text-left border-border text-faint">
              <th className="py-2 font-medium">SKU</th>
              <th className="py-2 font-medium">Description</th>
              <th className="py-2 font-medium">HTS</th>
              <th className="py-2 font-medium">Origin</th>
              <th className="py-2 text-right font-medium">Value</th>
              <th className="py-2 text-right font-medium">Duty</th>
              <th className="py-2 text-right font-medium">Rate</th>
              <th className="py-2 pl-3 font-medium">Flags</th>
            </tr>
          </thead>
          <tbody>
            {cat.items.map((i) => (
              <tr key={i.id} className="border-b border-hair">
                <td className="mono py-2 text-[13px]">{i.sku || "—"}</td>
                <td className="clamp-1 py-2 text-muted">{i.description}</td>
                <td className="mono py-2 text-[13px]">
                  {i.hts ? (
                    <Link
                      href={`/hts/${i.hts}`}
                      className="hover:underline text-accent"
                    >
                      {i.hts}
                    </Link>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="py-2 text-muted">{i.country}</td>
                <td className="mono py-2 text-right">{money2(i.value)}</td>
                <td className="mono py-2 text-right">
                  {i.duty !== null ? money2(i.duty) : "—"}
                </td>
                <td className="mono py-2 text-right">
                  {i.effective_rate !== null ? `${i.effective_rate}%` : "—"}
                </td>
                <td className="py-2 pl-3 text-[12px]">
                  {i.scope_unverified ? (
                    <Badge tone="warn">scope</Badge>
                  ) : i.confidence === "low" ? (
                    <Badge tone="warn">low</Badge>
                  ) : (
                    <span className="text-faint">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
