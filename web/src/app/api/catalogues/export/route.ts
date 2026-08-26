import { NextResponse } from "next/server";
import { currentViewer } from "@/lib/auth";
import { getCatalogue } from "@/lib/catalogues";
import { AUDIT_COLUMNS, csvFilename, toCsv } from "@/lib/csv";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const viewer = await currentViewer();
  if (!viewer) return NextResponse.json({ error: "sign in first" }, { status: 401 });

  const id = new URL(request.url).searchParams.get("id") ?? "";
  const cat = getCatalogue(viewer.account.id, id);
  if (!cat) return NextResponse.json({ error: "not found" }, { status: 404 });

  await audit("catalogue_exported", {
    accountId: viewer.account.id, email: viewer.account.email,
    detail: `${cat.items.length} products`,
  });

  const csv = toCsv(
    cat.items.map((i) => ({
      sku: i.sku ?? "",
      description: i.description,
      country: i.country,
      hts: i.hts ?? "",
      confidence: i.confidence ?? "",
      entered_value: i.value?.toFixed(2) ?? "",
      duty: i.duty?.toFixed(2) ?? "",
      effective_rate_pct: i.effective_rate?.toFixed(2) ?? "",
      refundable: i.refundable?.toFixed(2) ?? "",
      flags: i.scope_unverified ? "scope unverified" : "",
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
