import { NextResponse } from "next/server";
import { currentViewer } from "@/lib/auth";
import { getCatalogue } from "@/lib/catalogues";
import { AUDIT_COLUMNS, auditExportRow, csvFilename, toCsv } from "@/lib/csv";
import { isPriced } from "@/lib/auditModel";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const viewer = await currentViewer();
  if (!viewer) return NextResponse.json({ error: "sign in first" }, { status: 401 });

  const id = new URL(request.url).searchParams.get("id") ?? "";
  const cat = await getCatalogue(viewer.account.id, id);
  if (!cat) return NextResponse.json({ error: "not found" }, { status: 404 });

  await audit("catalogue_exported", {
    accountId: viewer.account.id, email: viewer.account.email,
    detail: `${cat.items.length} products`,
  });

  // Every saved line is exported, unresolved ones included, through the same
  // row builder as the audit page's download.
  const csv = toCsv(
    cat.items.map((i) => auditExportRow({
      row: i.row_number, sku: i.sku, description: i.description, country: i.country,
      hts: i.hts, status: i.status, error: i.error,
      review_reasons: i.review, warnings: i.warnings, incomplete: i.incomplete,
      confidence: i.confidence,
      entered_value: i.status && !isPriced(i.status) ? null : i.value,
      duty: i.duty, effective_rate_pct: i.effective_rate, refundable: i.refundable,
    })),
    AUDIT_COLUMNS,
  );

  return new NextResponse(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${csvFilename(cat.name)}"`,
      "cache-control": "no-store",
    },
  });
}
