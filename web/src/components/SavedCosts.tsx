"use client";
import { useState } from "react";
import { allocateCosts, landedCost, type LandedCostInputs, type AllocationLine } from "@/lib/landedCost";
import CostInputs from "./CostInputs";
export default function SavedCosts({ id, initial, goods, duty, partial, items, mpf }: { id: string; initial: LandedCostInputs; goods: number; duty: number; partial: boolean; items: AllocationLine[]; mpf: number | null }) {
  const [costs, setCosts] = useState(initial);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  let total = null, error = "";
  try { total = landedCost(goods, duty, costs); } catch (e) { error = (e as Error).message; }
  const allocated = total ? allocateCosts(items, costs, mpf) : [];
  return <form className="paper-card space-y-4 p-5" onSubmit={async (event) => {
    event.preventDefault(); setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/catalogues/costs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, costs }) });
      const result = await response.json();
      setMessage(response.ok ? "Import costs saved. Exports now include these amounts." : result.error);
    } catch { setMessage("Could not save. Please try again."); }
    finally { setBusy(false); }
  }}>
    <h2 className="serif text-xl">Landed-cost assumptions</h2>
    <p className="text-sm text-muted">Duty already includes recorded MPF and HMF; do not enter these fees again. Potential refunds are not deducted.</p>
    {partial && <p className="text-caution-ink">Partial estimate — unresolved or legacy duty information means this is not a complete shipment total.</p>}
    <CostInputs value={costs} onChange={(value) => { setMessage("Unsaved changes"); setCosts(value); }} />
    {error && <p role="alert">{error}</p>}
    <p className="mono">{partial ? "Partial landed estimate" : "Estimated landed cost"}: {total ? total.landed.toLocaleString("en-US", { style: "currency", currency: "USD" }) : "Enter valid costs"}</p>
    <details><summary>Per-product allocation (USD)</summary><div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr><th>Product</th><th>Additional costs</th><th>MPF share</th><th>Landed cost</th></tr></thead><tbody>{allocated.map((line, i) => <tr key={line.id}><td>{line.sku ?? `Line ${i + 1}`}</td><td>{line.additional_costs.toFixed(2)}</td><td>{line.mpf.toFixed(2)}</td><td>{line.landed === null ? "Not fully priced" : line.landed.toFixed(2)}</td></tr>)}</tbody></table></div></details>
    <button className="btn btn-primary" disabled={busy || !total}>{busy ? "Saving…" : "Save import costs"}</button><p role="status">{message}</p>
  </form>;
}
