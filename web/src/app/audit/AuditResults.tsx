"use client";

import { Fragment, useMemo, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui";
import { PartialMark } from "@/components/status";
import { LineFilterTabs, LineSummary, type LineFilterId } from "@/components/LineSummary";
import LineList from "@/components/LineList";
import { bucketOf, countLines, type AuditLine, type Status } from "@/lib/auditModel";
import type { Field } from "@/lib/csvParse";
import { landedCost, type LandedCostInputs } from "@/lib/landedCost";
import CostInputs from "@/components/CostInputs";

export type AuditSummary = {
  submitted: number;
  priced: number;
  unresolved: number;
  truncated: boolean;
  totals_complete: boolean;
  entered_value: number;
  duty: number;
  mpf: number;
  effective_rate_pct: number;
  potentially_refundable: number;
  assumptions: string[];
  dataset_revision: string;
  /** Echoed back by the proxy (lib/auditProof.ts), not the engine itself, so
   *  a save can record the shipment terms the fee figures rest on. */
  entries?: number;
  by_vessel?: boolean;
};

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const money = (n: number | undefined | null) =>
  typeof n === "number" && Number.isFinite(n) ? usd.format(n) : "—";

export const PAGE_SIZE = 100;

function LandedCostPanel({ goods, duty, inputs, onChange, partial }: { goods: number; duty: number; inputs: LandedCostInputs; onChange: (costs: LandedCostInputs) => void; partial: boolean }) {
  const [open, setOpen] = useState(false);
  let result = null, error = "";
  try { result = landedCost(goods, duty, inputs); } catch (e) { error = (e as Error).message; }
  return <section className="mt-5 rounded border border-rule bg-paper p-4" aria-label="Landed cost estimate">
    <button type="button" className="flex w-full items-center justify-between text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
      <span><span className="block text-[13px] font-medium text-muted">Optional</span><span className="block text-[16px] font-semibold">Estimate landed cost</span></span>
      <span className="text-sm text-muted">{open ? "Hide" : "Add import costs"} <span aria-hidden="true">{open ? "↑" : "↓"}</span></span>
    </button>
    {open ? <div className="mt-4 grid gap-5 lg:grid-cols-[1fr_280px]">
      <div><p className="mb-3 text-[13px] text-muted">Add costs outside the tariff calculation. These assumptions are included when you save the catalogue. Do not add MPF or HMF again.</p>
        {partial && <p role="status" className="text-caution-ink">Partial estimate: unresolved products or duties are missing from these totals.</p>}
        <CostInputs value={inputs} onChange={onChange} />
        {error && <p role="alert">{error}</p>}
      </div>
      <div className="rounded border border-rule bg-surface p-4"><div className="lbl">{partial ? "Partial landed estimate" : "Estimated landed cost"} (USD)</div><div className="mono mt-1 text-2xl font-semibold">{money(result?.landed)}</div><div className="mt-1 text-xs text-muted">{result?.landedRatePct.toFixed(2) ?? "—"}% of goods value</div><dl className="mt-4 space-y-2 text-sm"><div className="flex justify-between"><dt>Goods</dt><dd className="mono">{money(goods)}</dd></div><div className="flex justify-between"><dt>Duty and fees</dt><dd className="mono">{money(duty)}</dd></div><div className="flex justify-between"><dt>Added costs</dt><dd className="mono">{money(result?.totalExtras)}</dd></div></dl></div>
    </div> : null}
  </section>;
}

function Metric({
  label, value, sub, partial, tone,
}: {
  label: string; value: string; sub?: string; partial?: number; tone?: "recover";
}) {
  return (
    <div role="group" aria-label={label} className="metric-card">
      <div className="text-[13px] font-medium text-muted">{label}</div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className={`mono text-2xl font-semibold ${tone === "recover" ? "text-recover" : ""}`}>
          {value}
        </span>
        {partial ? <PartialMark unresolved={partial} /> : null}
      </div>
      {sub ? <div className="mt-1 text-[12px] text-muted">{sub}</div> : null}
    </div>
  );
}

function List({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div>
      <h4 className="mb-1 text-[14px] font-medium text-ink">{title}</h4>
      <ul className="list-disc space-y-0.5 pl-5 text-[13px]">
        {items.map((t, i) => <li key={i}>{t}</li>)}
      </ul>
    </div>
  );
}

const NEXT_STEP: Partial<Record<Status, { meaning: string; next: string }>> = {
  low_confidence: {
    meaning: "The code was matched to past customs rulings for a similar product, but nobody has confirmed it.",
    next: "Compare the candidate codes, then confirm the one that matches your product's material and use.",
  },
  suffix_review: {
    meaning: "The code is right to the subheading, but its final digits still need confirming.",
    next: "Confirm the full 10-digit code before you rely on this duty.",
  },
  scope_review: {
    meaning: "A trade-remedy heading might apply, but its scope note could not be matched to this product. The duty total leaves it out.",
    next: "Check whether your product falls within the heading listed below, with your broker if unsure.",
  },
  incomplete: {
    meaning: "A duty input is missing, so the duty shown is lower than what you may owe.",
    next: "Add the missing fact (for example a quantity for a per-unit duty, or a claimed program) and run the audit again.",
  },
};

function Detail({ line, onEdit, onSave, amount }: {
  line: AuditLine;
  onEdit: () => void;
  onSave: (changes: Partial<Record<Field, string>>) => void;
  amount: number;
}) {
  const uniq = (xs: string[], not: string[]) => [...new Set(xs)].filter((x) => x && !not.includes(x));
  const reasons = uniq([line.error ?? "", ...(line.review_reasons ?? [])], []);
  const incomplete = uniq(line.incomplete ?? [], reasons);
  const warnings = uniq(line.warnings ?? [], [...reasons, ...incomplete]);
  const suggested = line.suggested ?? [];
  const alternatives = line.alternatives ?? [];
  const scope = line.scope_unverified ?? [];
  const failed = bucketOf(line.status) === "failed";

  return (
    <div className="space-y-4 py-3 pl-1 pr-2 text-[13px]">
      {failed ? (
        <p className="rounded border-l-2 py-1.5 pl-3 border-danger bg-caution-soft text-danger">
          This line has no figures and is not in the totals.
        </p>
      ) : null}

      {NEXT_STEP[line.status] ? (
        <div className="rounded border border-rule bg-paper p-4 text-[15px] space-y-2">
          <p>{NEXT_STEP[line.status]!.meaning}</p>
          <p className="font-medium">Next step: {NEXT_STEP[line.status]!.next}</p>
          {line.status !== "ready" ? (
            <button type="button" onClick={onEdit} className="btn btn-secondary">Edit catalogue inputs</button>
          ) : null}
        </div>
      ) : null}

      <details className="border-t border-border pt-3">
        <summary className="cursor-pointer text-[14px] font-medium text-accent">Change this product&rsquo;s facts</summary>
        <form
          className="mt-3 grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            // Only fields the person changed are sent, so a column this file
            // does not have is never asked to change.
            const f = new FormData(e.currentTarget);
            const current: Record<Field, string> = {
              hts: line.hts ?? "",
              country: line.country,
              value: String(line.entered_value ?? amount),
              quantity: line.quantity === undefined ? "" : String(line.quantity),
            } as Record<Field, string>;
            const changes: Partial<Record<Field, string>> = {};
            for (const field of ["hts", "country", "value", "quantity"] as const) {
              const next = String(f.get(field) ?? "").trim();
              if (next !== current[field]) changes[field] = next;
            }
            if (Object.keys(changes).length) onSave(changes);
          }}
        >
          <label className="text-[13px]">HTS code
            <input name="hts" defaultValue={line.hts ?? ""} className="mono field-control mt-1 block w-full" />
          </label>
          <label className="text-[13px]">Country of origin
            <input name="country" defaultValue={line.country} className="field-control mt-1 block w-full" />
          </label>
          <label className="text-[13px]">Entered value (USD)
            <input name="value" defaultValue={String(line.entered_value ?? amount)} className="mono field-control mt-1 block w-full" />
          </label>
          <label className="text-[13px]">Quantity
            <input name="quantity" defaultValue={line.quantity === undefined ? "" : String(line.quantity)} className="mono field-control mt-1 block w-full" />
          </label>
          <div className="sm:col-span-2">
            <button type="submit" className="btn btn-primary">Save and run audit again</button>
          </div>
        </form>
      </details>

      {failed ? <List title="What went wrong" items={reasons} /> : null}
      <details className="border-t border-border pt-3">
        <summary className="cursor-pointer text-[14px] font-medium text-accent">Evidence and sources</summary>
        <div className="mt-3 space-y-4">
      {failed ? null : <List title="Why this needs review" items={reasons} />}
      <List title="Duty is understated because" items={incomplete} />
      <List title="Warnings" items={warnings} />

      {scope.length ? (
        <div>
          <h4 className="mb-1 text-[14px] font-medium text-ink">Trade-remedy headings awaiting scope confirmation</h4>
          <p className="mono text-[13px]">
            {scope.map((h, i) => (
              <span key={h}>{i ? ", " : ""}<Link href={`/hts/${h}`} className="hover:underline text-accent">{h}</Link></span>
            ))}
          </p>
        </div>
      ) : null}

      {suggested.length ? (
        <div>
          <h4 className="mb-1 text-[14px] font-medium text-ink">Classifier candidates</h4>
          <ol className="space-y-2">
            {suggested.map((c) => (
              <li key={c.hts} className="rounded border p-2 border-border">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                  <Link href={`/hts/${c.hts}?country=${encodeURIComponent(line.country || "")}`} className="mono font-medium hover:underline text-accent">{c.hts}</Link>
                  {c.hts === line.hts ? <Badge tone="good">Used for this price</Badge> : null}
                  <span className="text-muted">
                    {c.confidence ? `${c.confidence} confidence` : ""}
                    {typeof c.ruling_support === "number" ? ` · ${c.ruling_support} supporting rulings` : ""}
                  </span>
                </div>
                {c.description ? <div className="text-muted">{c.description}</div> : null}
                {c.rulings?.length ? (
                  <div className="mt-1 text-[12px] text-faint">
                    Rulings:{" "}
                    {c.rulings.slice(0, 3).map((r, i) => (
                      <span key={r.ruling}>
                        {i ? ", " : ""}
                        {r.url ? (
                          <a href={r.url} target="_blank" rel="noopener noreferrer" className="hover:underline text-accent">
                            {r.ruling}
                          <span aria-hidden="true" className="ml-0.5">↗</span><span className="sr-only"> (opens in a new tab)</span></a>
                        ) : r.ruling}
                        {r.revoked ? " (revoked)" : ""}
                      </span>
                    ))}
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {alternatives.length ? (
        <div>
          <h4 className="mb-1 text-[14px] font-medium text-ink">Sibling statistical lines with different rates</h4>
          <ul className="space-y-1">
            {alternatives.map((a) => (
              <li key={a.hts} className="flex flex-wrap gap-x-3">
                <Link href={`/hts/${a.hts}?country=${encodeURIComponent(line.country || "")}`} className="mono hover:underline text-accent">{a.hts}</Link>
                <span className="text-muted">{a.description}</span>
                {a.general_rate ? <span className="mono text-faint">{a.general_rate}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
        </div>
      </details>
    </div>
  );
}

export default function AuditResults({
  summary, lines, inputs, landedCosts, onCostsChange, onEdit, onRowSave,
}: {
  landedCosts: LandedCostInputs;
  onCostsChange: (costs: LandedCostInputs) => void;
  onEdit: () => void;
  onRowSave: (row: number, changes: Partial<Record<Field, string>>) => void;
  summary: AuditSummary;
  lines: AuditLine[];
  /** The amount submitted for each line, shown where a line carries none. */
  inputs: number[];
}) {
  const counts = useMemo(() => countLines(lines), [lines]);
  const [filter, setFilter] = useState<LineFilterId>("all");
  const [page, setPage] = useState(0);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("original");

  const shown = useMemo(() => {
    const term = query.trim().toLowerCase();
    const rows = lines.map((line, i) => ({ line, i })).filter(({ line }) =>
      (filter === "all" || bucketOf(line.status) === filter) &&
      (!term || [line.sku, line.description, line.hts, line.country].some((value) => value?.toLowerCase().includes(term))),
    );
    if (sort === "duty") rows.sort((a, b) => (b.line.duty ?? -1) - (a.line.duty ?? -1));
    if (sort === "value") rows.sort((a, b) => (b.line.entered_value ?? inputs[b.i] ?? -1) - (a.line.entered_value ?? inputs[a.i] ?? -1));
    return rows;
  }, [lines, filter, query, sort, inputs]);
  const pages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
  const at = Math.min(page, pages - 1);
  const slice = shown.slice(at * PAGE_SIZE, (at + 1) * PAGE_SIZE);

  const partial = !summary.totals_complete || counts.unresolved > 0;
  const unresolved = counts.unresolved;
  const filterCount: Record<LineFilterId, number> = {
    all: counts.submitted, review: counts.review, ready: counts.ready, failed: counts.failed,
  };

  return (
    <section className="space-y-5" aria-label="Audit results">
      <LineSummary
        headingId="results-heading"
        submitted={counts.submitted}
        unresolved={unresolved}
        duty={summary.duty}
        partial={partial}
        review={counts.review}
        failed={counts.failed}
        ready={counts.ready}
        aside={<>Open a row to see what it means and what to do <a href="#save-results" className="btn btn-secondary">Save these results ↓</a></>}
        action={unresolved > 0 ? (
          <button
            type="button"
            onClick={() => { setFilter(counts.review > 0 ? "review" : "failed"); setPage(0); }}
            className="btn btn-primary"
          >
            {counts.review > 0
              ? `Review the ${counts.review.toLocaleString()} to confirm`
              : `See the ${counts.failed.toLocaleString()} that could not be priced`}
          </button>
        ) : undefined}
      />

      {summary.truncated ? (
        <p className="rounded border-l-2 py-2 pl-3 text-[14px] border-caution bg-caution-soft text-caution-ink">
          The time budget for one run was reached, so some lines were not processed. They are listed below as
          “Not processed” and are not in the totals. Run the remainder as a separate catalogue.
        </p>
      ) : null}


      <div className="panel space-y-4 p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <label className="flex-1 space-y-1.5"><span className="text-[13px] font-medium">Find a product</span><input data-search type="search" value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }} placeholder="Search SKU, description, code, or origin" className="field-control" /></label>
        <label className="space-y-1.5 sm:w-52"><span className="text-[13px] font-medium">Sort results</span><select value={sort} onChange={(event) => { setSort(event.target.value); setPage(0); }} className="field-control"><option value="original">Original row order</option><option value="duty">Highest duty first</option><option value="value">Highest value first</option></select></label>
      </div>
      <LineFilterTabs counts={filterCount} active={filter} onSelect={(id) => { setFilter(id); setPage(0); }} />

      <p role="status" className="text-xs text-muted">{shown.length.toLocaleString()} of {lines.length.toLocaleString()} products match</p>
      </div>

      {!shown.length ? (
        <div className="panel px-5 py-10 text-center"><p className="font-medium">No products match this view</p><p className="mt-2 text-sm text-muted">Try a different search or show all review statuses.</p><button type="button" onClick={() => { setQuery(""); setFilter("all"); setPage(0); }} className="btn btn-secondary mt-5">Clear search and filters</button></div>
      ) : (
        <LineList
          label="Audited products"
          caption={`Audited lines, ${shown.length} shown, page ${at + 1} of ${pages}`}
          lines={slice.map(({ line: l, i }) => ({
            key: String(i),
            row: l.row,
            sku: l.sku ?? null,
            description: l.description ?? null,
            country: l.country ?? null,
            hts: l.hts ?? null,
            value: l.entered_value ?? (inputs[i] > 0 ? inputs[i] : null),
            duty: l.duty ?? null,
            status: l.status,
          }))}
          renderDetail={(key) => {
            const i = Number(key);
            const l = lines[i];
            return <Detail line={l} onEdit={onEdit} amount={inputs[i] ?? 0} onSave={(c) => onRowSave(l.row, c)} />;
          }}
        />
      )}

      {pages > 1 ? (
        <nav aria-label="Result pages" className="flex flex-wrap items-center gap-3 text-[13px]">
          <button
            type="button"
            disabled={at === 0}
            onClick={() => setPage(at - 1)}
            className="rounded border px-3 py-1.5 border-rule disabled:opacity-40"
          >
            Previous
          </button>
          <span role="status" className="text-muted">
            Lines {at * PAGE_SIZE + 1}–{Math.min((at + 1) * PAGE_SIZE, shown.length)} of {shown.length.toLocaleString()}
          </span>
          <button
            type="button"
            disabled={at >= pages - 1}
            onClick={() => setPage(at + 1)}
            className="rounded border px-3 py-1.5 border-rule disabled:opacity-40"
          >
            Next
          </button>
        </nav>
      ) : null}

      <div className="space-y-5 border-t pt-5 border-border">
        <p className="text-[13px] font-medium text-muted">Totals for this audit</p>
      <div className="panel grid grid-cols-2 divide-x divide-y divide-border lg:grid-cols-4 [&_.metric-card]:border-0 [&_.metric-card]:bg-transparent [&_.metric-card]:p-4">
        <Metric
          label="Entered value"
          value={money(summary.entered_value)}
          sub={`${summary.priced.toLocaleString()} of ${counts.submitted.toLocaleString()} lines priced`}
        />
        <Metric
          label="Duty and fees"
          value={money(summary.duty)}
          sub={`${summary.effective_rate_pct}% effective · includes ${money(summary.mpf)} MPF`}
          partial={partial ? unresolved : undefined}
        />
        <Metric
          label="Potentially refundable"
          value={money(summary.potentially_refundable)}
          sub="Estimate: IEEPA duties struck down, not a filed claim"
          tone="recover"
        />
        <Metric
          label="Needs attention"
          value={unresolved.toLocaleString()}
          sub={`${counts.review.toLocaleString()} to review · ${counts.failed.toLocaleString()} failed`}
        />
      </div>
      <LandedCostPanel goods={summary.entered_value} duty={summary.duty} inputs={landedCosts} onChange={onCostsChange} partial={partial} />

      <details className="text-[13px]">
        <summary className="cursor-pointer text-muted hover:underline">
          Assumptions behind these figures ({summary.assumptions.length})
        </summary>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">
          {summary.assumptions.map((a, i) => <li key={i}>{a}</li>)}
        </ul>
      </details>
      <p className="mt-0 text-[11px] text-faint">
        Reference data revision:{" "}
        <span className="mono">{summary.dataset_revision || "not reported"}</span>
      </p>
      </div>
    </section>
  );
}
