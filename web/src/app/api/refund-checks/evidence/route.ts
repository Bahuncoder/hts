import { NextResponse } from "next/server";
import { currentViewer } from "@/lib/auth";
import { getRefundCheck } from "@/lib/refundCheck";
import { audit } from "@/lib/audit";

/** Same shape as api/catalogues/evidence/route.ts: auth check, build a plain
 *  object, log, download as JSON. No classifier-evidence projection here --
 *  unlike a catalogue line, a refund-check item never carries ruling
 *  snapshots (3a never re-classifies against a declared entry_hts; that
 *  comparison is explicitly deferred), so there is nothing to sanitize. */
export const runtime = "nodejs";

export async function GET(request: Request) {
  const viewer = await currentViewer();
  if (!viewer) return NextResponse.json({ error: "sign in first" }, { status: 401 });
  const id = new URL(request.url).searchParams.get("id") ?? "";
  const check = await getRefundCheck(viewer.account.id, id);
  if (!check) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = {
    format: "htsdesk-refund-check-evidence-v1",
    generated_at: new Date().toISOString(),
    limitations: [
      "Struck-down-duty figures reflect the IEEPA ruling and today's Chapter 99 schedule, not an independent verification of your entry.",
      "Timing (Post Summary Correction / protest) is estimated from standard statutory deadlines, not confirmed against CBP's record of this entry.",
      "This is not legal advice, a claim amount, or a promise of recovery. Confirm with CBP or a licensed customs broker before relying on it for a filing.",
    ],
    refund_check: { id: check.id, name: check.name, created_at: check.created_at, updated_at: check.updated_at },
    items: check.items.map((it) => ({
      row: it.row, sku: it.sku, description: it.description, country: it.country, value: it.value,
      entry_hts: it.entry_hts, entry_date: it.entry_date, duty_paid: it.duty_paid,
      liquidation_date: it.liquidation_date, computed_hts: it.computed_hts, computed_duty: it.computed_duty,
      struck_down_refundable: it.struck_down_refundable,
      psc_eligible: it.psc_eligible, psc_detail: it.psc_detail,
      protest_deadline: it.protest_deadline, protest_detail: it.protest_detail,
      disclaimer: it.disclaimer, status: it.status,
    })),
  };
  await audit("refund_check_evidence_exported", {
    accountId: viewer.account.id, email: viewer.account.email,
    detail: `${check.items.length} entries`,
  });
  const filename = `${check.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "refund-check"}-evidence.json`;
  return new NextResponse(JSON.stringify(body, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}
