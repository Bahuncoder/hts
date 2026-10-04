import Link from "next/link";
import EmptyState from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { requireViewer } from "@/lib/auth";
import { listRefundChecks } from "@/lib/refundCheck";
import { Card } from "@/components/ui";
import RefundCheckClient from "@/components/RefundCheckClient";
import { money2 } from "@/lib/api";

export const metadata = {
  title: "Entry Refund Check",
  description: "Check entries you already filed against today's rules for struck-down duty and CBP timing windows.",
};
export const dynamic = "force-dynamic";

export default async function RefundCheckPage() {
  const viewer = await requireViewer("/refund-check");
  const { limits } = viewer;

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Your import workspace"
        title="Entry Refund Check"
        description="Check entries you already filed against today's rules: struck-down IEEPA duty, and CBP's Post Summary Correction / protest timing windows."
      />

      {!limits.refundCheck.enabled ? (
        <EmptyState
          title="Entry Refund Check is not on your current plan"
          action={{ href: "/pricing", label: "See plans" }}
        >
          <p>
            It checks entries you have already filed for two things: struck-down IEEPA duty you may be able to
            recover, and whether CBP&rsquo;s correction and protest windows are still open.
          </p>
          <p>
            For each entry you will need the product, its HTS code, origin, value, the entry date, the duty paid,
            and the liquidation date if it has liquidated. Those are the columns the check reads from a CSV.
          </p>
        </EmptyState>
      ) : (
        <>
          <RefundCheckClient maxRows={limits.productsPerAudit} />
          <RefundCheckHistory accountId={viewer.account.id} />
        </>
      )}
    </div>
  );
}

async function RefundCheckHistory({ accountId }: { accountId: string }) {
  const checks = await listRefundChecks(accountId);
  if (!checks.length) return null;
  return (
    <div className="space-y-3">
      <h2 className="text-[15px] font-semibold">Past checks</h2>
      <div className="space-y-3">
        {checks.map((c) => (
          <Card key={c.id}>
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="space-y-1">
                <Link href={`/refund-check/${c.id}`} className="text-[16px] font-semibold hover:underline">{c.name}</Link>
                <div className="text-[13px] text-faint">
                  {c.items.toLocaleString()} {c.items === 1 ? "entry" : "entries"} · checked{" "}
                  <span className="nb">
                    {new Date(c.created_at).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}
                  </span>
                </div>
              </div>
              {c.struck_down_refundable > 0 ? (
                <div className="text-right">
                  <div className="lbl" style={{ color: "var(--recover)" }}>Refundable</div>
                  <div className="mono text-[16px]" style={{ color: "var(--recover)" }}>{money2(c.struck_down_refundable)}</div>
                </div>
              ) : null}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
