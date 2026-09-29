import Link from "next/link";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { currentViewer } from "@/lib/auth";
import { listRefundChecks } from "@/lib/refundCheck";
import { Card, Note } from "@/components/ui";
import RefundCheckClient from "@/components/RefundCheckClient";
import { money2 } from "@/lib/api";

export const metadata = {
  title: "Entry Refund Check",
  description: "Check entries you already filed against today's rules for struck-down duty and CBP timing windows.",
};
export const dynamic = "force-dynamic";

export default async function RefundCheckPage() {
  const viewer = await currentViewer();
  if (!viewer) redirect("/login");
  const { limits } = viewer;

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Your import workspace"
        title="Entry Refund Check"
        description="Check entries you already filed against today's rules: struck-down IEEPA duty, and CBP's Post Summary Correction / protest timing windows."
      />

      {!limits.refundCheck.enabled ? (
        <Note>
          Entry Refund Check is not included on your current plan.{" "}
          <Link href="/pricing" className="font-medium underline">See plans</Link> to upgrade.
        </Note>
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
