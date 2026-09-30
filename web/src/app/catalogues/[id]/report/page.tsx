import { notFound } from "next/navigation";
import { requireViewer } from "@/lib/auth";
import { catalogueTotals, getCatalogue } from "@/lib/catalogues";
import { EMPTY_COSTS, COST_FIELDS, allocateCosts, landedCost, parseCosts } from "@/lib/landedCost";
import { LEGACY_LABEL, STATUS_LABEL } from "@/lib/auditModel";
import { money2 } from "@/lib/api";
import PrintReport from "@/components/PrintReport";
import EvidenceSnapshot from "@/components/EvidenceSnapshot";
import { listReviews } from "@/lib/reviews";
export const dynamic = "force-dynamic";
export default async function Report({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const viewer = await requireViewer(`/catalogues/${id}/report`);
  const cat = await getCatalogue(viewer.account.id, id);
  if (!cat) notFound();
  const totals = catalogueTotals(cat.items, cat.mpf);
  const costs = cat.landed_cost_json ? parseCosts(JSON.parse(cat.landed_cost_json)) : EMPTY_COSTS;
  const landed = landedCost(totals.value, totals.duty, costs);
  const allocation = allocateCosts(cat.items, costs, cat.mpf);
  const history = await listReviews(viewer.account.id, cat.id);
  return <article className="space-y-6 print:text-black print:bg-white">
    <header><h1 className="serif text-3xl">{cat.name} — evidence report</h1><p>Catalogue {cat.id}</p><PrintReport /></header>
    <section><h2 className="text-xl font-semibold">Calculation record</h2>
      <p>Calculated: {cat.calculated_at ?? "Not recorded"} · Dataset: {cat.dataset_revision ?? "Not recorded"}</p>
      <p>Saved: {cat.created_at} · Updated: {cat.updated_at}</p>
      <p>{cat.totals_complete === 1 ? "Calculation complete" : cat.totals_complete === null ? "Legacy record — completeness unknown" : "Partial estimate — unresolved amounts remain"}</p>
      <p>Calculation status and human review decisions are recorded separately. Approval does not remove calculation warnings. Ruling evidence below reflects the calculation date.</p>
      <ul className="list-disc pl-5">{cat.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul>
    </section>
    <section><h2 className="text-xl font-semibold">Cost summary (USD)</h2>
      <p>Recorded goods value: {money2(totals.value)} · Duty and fees: {money2(totals.duty)}</p>
      <p>MPF: {cat.mpf === null ? "Not recorded" : money2(cat.mpf)} (already included in duty and fees)</p>
      <p>Additional-cost currency: {costs.currency ?? "USD"}. Allocation: {costs.allocation === "equal" ? "Equal shares per line" : "By goods value (equal shares for zero total value)"}.</p>
      {(costs.currency ?? "USD") !== "USD" && <p>Exchange rate: 1 {costs.currency} = {costs.usdRate} USD · {costs.rateDate} · Source: {costs.rateSource}</p>}
      {COST_FIELDS.map(([key, label]) => <p key={key}>{label}: {costs[key].toFixed(2)} {costs.currency ?? "USD"} → {money2(landed[key])}</p>)}
      <p className="font-semibold">{cat.totals_complete === 1 ? "Estimated landed cost" : "Partial landed estimate"}: {money2(landed.landed)}</p>
      <p>Potential refunds: {money2(totals.refundable)} — not deducted from estimated cost.</p>
    </section>
    <section className="space-y-4"><h2 className="text-xl font-semibold">All saved products ({cat.items.length})</h2>
      {cat.items.map((item, index) => <section key={item.id} className="break-inside-avoid border-t border-rule pt-3">
        <h3 className="font-semibold">{item.row_number ?? index + 1}. {item.description}</h3>
        <p>SKU: {item.sku ?? "Not recorded"} · Origin: {item.country} · HTS: {item.hts ?? "Unclassified"}</p>
        <p>{item.status ? STATUS_LABEL[item.status] : LEGACY_LABEL} · Confidence: {item.confidence ?? "Not recorded"}</p>
        <p>Recorded value: {money2(item.value)} · Line duty excluding MPF: {item.duty === null ? "Not priced" : money2(item.duty)}</p>
        <p>Allocated additional costs: {money2(allocation[index].additional_costs)} · MPF: {cat.mpf === null ? "Not recorded" : money2(allocation[index].mpf)} · Landed: {allocation[index].landed === null ? "Not fully priced" : money2(allocation[index].landed!)}</p>
        <ul className="list-disc pl-5">{[item.error, ...item.review, ...item.warnings, ...item.incomplete].filter(Boolean).map((note, n) => <li key={n}>{note}</li>)}</ul>
        <h4 className="font-semibold">Saved classification evidence</h4><EvidenceSnapshot json={item.evidence_json} />
        <h4 className="font-semibold">Human review: {item.review_status.replaceAll("_", " ")}</h4>
        {history.filter((event) => event.item_id === item.id).map((event) => <div key={event.id}><p>{event.actor_email} · {event.at} · {event.action.replaceAll("_", " ")}</p>{event.action === "assignment" && <p>Assigned to: {event.assigned_to || "Unassigned"}</p>}<p className="whitespace-pre-wrap">{event.note}</p></div>)}
        {!history.some((event) => event.item_id === item.id) && <p>No human review recorded.</p>}
      </section>)}
    </section>
  </article>;
}
