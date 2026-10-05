import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { requireViewer } from "@/lib/auth";
import { getRefundCheck } from "@/lib/refundCheck";
import { deleteRefundCheckAction } from "@/lib/actions";
import { Badge, Card } from "@/components/ui";
import { money2 } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function RefundCheckDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const viewer = await requireViewer(`/refund-check/${id}`);
  const check = await getRefundCheck(viewer.account.id, id);
  if (!check) notFound();

  const total = check.items.reduce((sum, it) => sum + it.struck_down_refundable, 0);

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Saved refund check" title={check.name} description={`Checked ${new Date(check.created_at).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })} · ${check.items.length} ${check.items.length === 1 ? "entry" : "entries"}`}>
        <a href={`/api/refund-checks/evidence?id=${check.id}`} className="btn btn-secondary">Export evidence</a>
        <form action={deleteRefundCheckAction}>
          <input type="hidden" name="id" value={check.id} />
          <button className="btn bg-danger text-on-accent hover:brightness-90">Delete</button>
        </form>
      </PageHeader>

      {total > 0 ? (
        <p className="border-l-2 py-2 pl-3 text-[13px] border-recover">
          <span className="lbl block" style={{ color: "var(--recover)" }}>Scenario estimate</span>
          About <span className="mono font-medium">{money2(total)}</span> of the duty paid across these entries may
          be recoverable (struck-down IEEPA duty). This is not a claim amount — confirm with CBP or a licensed
          customs broker before relying on it for a filing.
        </p>
      ) : null}

      <div className="space-y-3">
        {check.items.map((it) => (
          <Card key={it.id} className="space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-[15px] font-medium">{it.description}</p>
                <p className="text-[13px] text-faint">{it.country} · entered {new Date(it.entry_date).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}</p>
              </div>
              <div className="text-right">
                <div className="lbl">Duty paid</div>
                <div className="mono text-[16px]">{money2(it.duty_paid)}</div>
              </div>
              {it.struck_down_refundable > 0 ? (
                <div className="text-right">
                  <div className="lbl" style={{ color: "var(--recover)" }}>Refundable</div>
                  <div className="mono text-[16px]" style={{ color: "var(--recover)" }}>{money2(it.struck_down_refundable)}</div>
                </div>
              ) : null}
            </div>
            <div className="grid gap-3 border-t border-hair pt-3 text-[13px] sm:grid-cols-2">
              <div>
                <Badge tone={it.psc_eligible === "may be available" ? "good" : "neutral"}>{it.psc_eligible}</Badge>
                <p className="mt-1.5 text-muted">{it.psc_detail}</p>
              </div>
              <div>
                <Badge tone="neutral">Protest deadline: {it.protest_deadline}</Badge>
                <p className="mt-1.5 text-muted">{it.protest_detail}</p>
              </div>
            </div>
            {it.classifier_suggested_hts ? (
              <details className="rounded border border-rule bg-surface px-3 py-2 text-[13px]">
                <summary className="cursor-pointer font-medium text-muted">
                  Classifier read this description differently
                </summary>
                <div className="mt-2 flex items-start gap-2">
                  <Badge tone="neutral">{it.classifier_confidence} confidence</Badge>
                  <p className="text-muted">
                    For reference only: entering just this product description into our classifier today returns{" "}
                    <span className="mono font-medium text-ink">{it.classifier_suggested_hts}</span>, a different
                    code than the <span className="mono font-medium text-ink">{it.entry_hts}</span> on this entry.
                    This is not a classification of your entry and not a finding that {it.entry_hts} was wrong — a
                    short text description often can&rsquo;t capture the construction, composition or use facts
                    that decide between similar codes. It has no effect on the figures above.
                  </p>
                </div>
              </details>
            ) : null}
          </Card>
        ))}
      </div>

      <p className="text-[12px] text-faint">
        {check.items[0]?.disclaimer}{" "}
        <Link href="/refund-check" className="underline">Back to Entry Refund Check</Link>.
      </p>
    </div>
  );
}
