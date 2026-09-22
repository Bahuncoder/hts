import { NextResponse } from "next/server";
import { currentViewer } from "@/lib/auth";
import { getCatalogue, catalogueTotals, itemUnresolved } from "@/lib/catalogues";
import { audit } from "@/lib/audit";
import { EMPTY_COSTS, allocateCosts, landedCost, parseCosts } from "@/lib/landedCost";
import { projectEvidence } from "@/lib/evidence";
import { listReviews } from "@/lib/reviews";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const viewer = await currentViewer();
  if (!viewer) return NextResponse.json({ error: "sign in first" }, { status: 401 });
  const id = new URL(request.url).searchParams.get("id") ?? "";
  const cat = await getCatalogue(viewer.account.id, id);
  if (!cat) return NextResponse.json({ error: "not found" }, { status: 404 });
  const totals = catalogueTotals(cat.items, cat.mpf);
  const history = await listReviews(viewer.account.id, cat.id);
  const costs = cat.landed_cost_json ? parseCosts(JSON.parse(cat.landed_cost_json)) : EMPTY_COSTS;
  const body = {
    format: "htsdesk-evidence-v2", generated_at: new Date().toISOString(),
    evidence_limitations: ["Rulings are excerpts and reflect the saved calculation date. Legacy lines may lack snapshots.", "Human review decisions do not change the engine's calculation status or remove warnings."],
    review_history: history,
    per_product_allocation: allocateCosts(cat.items, costs, cat.mpf),
    landed_cost: { currency: "USD", partial: cat.totals_complete !== 1,
      ...landedCost(totals.value, totals.duty, costs) },
    catalogue: { id: cat.id, name: cat.name, created_at: cat.created_at, updated_at: cat.updated_at },
    calculation: { dataset_revision: cat.dataset_revision, calculated_at: cat.calculated_at,
      assumptions: cat.assumptions, totals_complete: cat.totals_complete === null ? null : cat.totals_complete === 1,
      entered_value: totals.value, duty_and_fees: totals.duty, mpf: cat.mpf,
      potentially_refundable: totals.refundable },
    review: { total_lines: cat.items.length, needs_attention: cat.items.filter(itemUnresolved).length,
      lines: cat.items.map((item) => ({ row: item.row_number, sku: item.sku, description: item.description,
        country: item.country, hts: item.hts, status: item.status, value: item.value, duty: item.duty,
        effective_rate_pct: item.effective_rate, refundable: item.refundable, confidence: item.confidence,
        error: item.error, review: item.review, warnings: item.warnings, incomplete: item.incomplete,
        human_review_status: item.review_status, review_version: item.review_version,
        evidence: item.evidence_json ? projectEvidence(JSON.parse(item.evidence_json)) : null })) },
  };
  await audit("catalogue_evidence_exported", { accountId: viewer.account.id, email: viewer.account.email, detail: `${cat.items.length} products` });
  const filename = `${cat.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "catalogue"}-evidence.json`;
  return new NextResponse(JSON.stringify(body, null, 2), { headers: {
    "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="${filename}"`, "cache-control": "no-store",
  }});
}
