"use client";
import { useEffect, useState } from "react";
import { ALLOCATION_METHODS, COST_FIELDS, CURRENCIES, MAX_COST, MAX_USD_RATE, type LandedCostInputs } from "@/lib/landedCost";

/** Shared by the audit preview and saved-catalogue editor. No fetched or
 * silently changing FX rate: the user's dated rate remains part of the record. */
export default function CostInputs({ value, onChange }: { value: LandedCostInputs; onChange: (v: LandedCostInputs) => void }) {
  const currency = value.currency ?? "USD";
  // Node and the browser can ship different ICU currency lists. Render the
  // selected currency identically on both, then populate browser choices.
  const [currencies, setCurrencies] = useState(() => [...new Set(["USD", currency])]);
  useEffect(() => setCurrencies(CURRENCIES), []);
  return <div className="grid gap-3 sm:grid-cols-2">
    <label>Additional-cost currency<select aria-label="Additional-cost currency" className="field-control w-full" value={currency} onChange={(e) => onChange({ ...value, currency: e.target.value, usdRate: e.target.value === "USD" ? 1 : undefined, rateDate: undefined, rateSource: undefined })}>{currencies.map((c) => <option key={c}>{c}</option>)}</select></label>
    <label>Allocate shipment costs<select className="field-control w-full" value={value.allocation ?? "value"} onChange={(e) => onChange({ ...value, allocation: e.target.value as "value" | "equal" })}>{ALLOCATION_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}</select></label>
    {currency !== "USD" && <>
      <label>USD per 1 {currency}<input className="field-control w-full" type="number" min="0.000000001" max={MAX_USD_RATE} step="any" required value={value.usdRate ?? ""} onChange={(e) => onChange({ ...value, usdRate: Number(e.target.value) })} /></label>
      <label>Rate date<input className="field-control w-full" type="date" required value={value.rateDate ?? ""} onChange={(e) => onChange({ ...value, rateDate: e.target.value })} /></label>
      <label className="sm:col-span-2">Rate source<input className="field-control w-full" maxLength={200} required placeholder="Bank quote or published source" value={value.rateSource ?? ""} onChange={(e) => onChange({ ...value, rateSource: e.target.value })} /></label>
    </>}
    {COST_FIELDS.map(([key, label]) => <label key={key}>{label} ({currency})<input className="field-control w-full" type="number" min="0" max={MAX_COST} step="0.01" required value={value[key]} onChange={(e) => onChange({ ...value, [key]: Number(e.target.value) })} /></label>)}
    <p className="sm:col-span-2 text-xs text-muted">Goods and duties remain in USD. Only additional costs are converted. Enter your actual exchange rate; no live rate is assumed. Value allocation uses equal shares when all goods values are zero.</p>
  </div>;
}
