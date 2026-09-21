import { money2, type Quote } from "@/lib/api";

/** Whether the total can be read as the whole duty for the inputs given.
 *  Trusts the engine's `complete` flag and falls back to its two inputs, so an
 *  older engine can never make an incomplete total look complete. */
export function isComplete(q: Quote): boolean {
  if (typeof q.complete === "boolean") return q.complete;
  return !(q.incomplete?.length || q.scope_unverified?.length);
}

const REASONS: Record<string, string> = {
  specific_duty_omitted:
    "This line has a per-unit duty (per kg, per piece) and no quantity was given; it is not included. Enter the quantity to price it.",
  quantity_unit_mismatch:
    "The quantity's unit cannot be converted to the unit this duty is charged in; the duty is not included.",
  specific_duty_unsupported:
    "This line's duty has a form this calculator cannot price (for example a sliding scale or a per-content rate); that part is not included.",
  adcvd_possible:
    "An antidumping or countervailing duty order may cover these goods; its cash deposit depends on the exporter and is not included.",
  deal_rate_unresolved:
    "A trade-deal duty for this origin depends on this line's per-unit rate, which is not priced; it is not included.",
  rate_missing:
    "No base rate of duty was found for this line, so no base duty is included.",
  rate_unparsed:
    "Part of the base rate could not be interpreted; that part is not included.",
};

/** Plain-English reasons the total leaves something out. */
export function incompleteReasons(q: Quote): string[] {
  const out = (q.incomplete ?? []).map(
    (r) =>
      REASONS[r] ??
      "Something this line requires is not included in the total.",
  );
  if (q.scope_unverified?.length) {
    const n = q.scope_unverified.length;
    out.push(
      `${n === 1 ? "One trade-remedy heading" : `${n} trade-remedy headings`} (${q.scope_unverified.join(", ")}) may apply to this entry, but ${n === 1 ? "its" : "their"} product scope is defined only in the Chapter 99 U.S. Notes and could not be resolved. ${n === 1 ? "It is" : "They are"} excluded from this total until scope is verified.`,
    );
  }
  if (q.adcvd?.length) {
    const shown = q.adcvd.slice(0, 4).map((o) => `${o.case} ${o.product}`).join("; ");
    out.push(
      `${q.adcvd.length === 1 ? "One order lists" : `${q.adcvd.length} orders list`} this code for ${q.country} (${shown}${q.adcvd.length > 4 ? "; ..." : ""}). Check whether your goods and exporter are covered.`,
    );
  }
  const asks = (q.facts_needed ?? [])
    .map((f) => FACT_ASKS[f])
    .filter((t): t is string => Boolean(t));
  if (asks.length) out.push(`To settle this, state ${asks.join(" and ")} under "About the goods".`);
  return out;
}

const FACT_ASKS: Record<string, string> = {
  metal_weight_pct: "the share of the article's weight that is aluminum, steel or copper",
  vehicle_use: "whether the goods are parts of a passenger vehicle, a heavy-duty vehicle, or neither",
};

/** Sits directly under a money figure. Renders nothing for a complete total. */
export function IncompleteReasons({ quote }: { quote: Quote }) {
  if (isComplete(quote)) return null;
  const reasons = incompleteReasons(quote);
  return (
    <div className="mt-2 border-l-2 pl-3 text-[12px] leading-snug border-caution text-caution-ink">
      <p className="font-medium">The total is understated because:</p>
      <ul className="mt-1 list-disc space-y-1 pl-4">
        {reasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
    </div>
  );
}

/** The assumptions behind the figure, kept next to it. */
export function ScenarioLine({
  quote,
  byVessel = true,
  formalEntry = true,
  program,
  quantity,
}: {
  quote: Quote;
  byVessel?: boolean;
  formalEntry?: boolean;
  program?: string;
  quantity?: string;
}) {
  const origin = quote.country_code
    ? `${quote.country} (${quote.country_code})`
    : quote.country;
  return (
    <p role="status" className="text-[13px] text-muted">
      Scenario for one entry at {money2(quote.entered_value)} entered value ·
      origin {origin} · {byVessel ? "sea (vessel)" : "air"} ·{" "}
      {formalEntry ? "formal" : "informal"} entry
      {program ? ` · special-rate program ${program} requested` : ""}
      {quantity ? ` · quantity ${quantity}` : ""}
      {quote.dataset_revision ? (
        <>
          {" "}
          · dataset revision{" "}
          <span className="mono text-[12px]">{quote.dataset_revision}</span>
        </>
      ) : null}
    </p>
  );
}

/** What the duty rests on that we cannot check from a catalogue. Shown beside
 *  the figure, so a charge applied under an assumption never looks unconditional. */
export function Assumptions({ quote }: { quote: Quote }) {
  const list = quote.assumptions ?? [];
  if (!list.length) return null;
  return (
    <div className="text-[12px] leading-snug text-muted">
      <p className="font-medium">This figure assumes:</p>
      <ul className="mt-1 list-disc space-y-1 pl-4">
        {list.map((a) => (
          <li key={a}>{a}</li>
        ))}
      </ul>
    </div>
  );
}

/** The IEEPA figure, framed as what it is: an estimate for a hypothetical
 *  entry. The tool has no entry date, paid duty or liquidation status, so it
 *  can never say a customer paid or can recover this amount. */
export function RefundScenario({
  amount,
  entered,
}: {
  amount: number;
  entered: number;
}) {
  if (amount <= 0) return null;
  return (
    <p className="border-l-2 py-2 pl-3 text-[13px] border-recover">
      <span className="lbl block" style={{ color: "var(--recover)" }}>
        Scenario estimate
      </span>
      If IEEPA duty was paid on an entry like this ({money2(entered)}), about{" "}
      <span className="mono font-medium">{money2(amount)}</span> of it may be
      recoverable. Actual eligibility depends on the entries you filed, their
      liquidation status and CBP&rsquo;s refund process; this figure is not a
      claim amount.
    </p>
  );
}
