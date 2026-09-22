"use client";

import { Fragment, useMemo, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui";
import { PartialMark, StatusChip } from "@/components/status";
import { bucketOf, countLines, type AuditLine, type Bucket } from "@/lib/auditModel";
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
};

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const money = (n: number | undefined | null) =>
  typeof n === "number" && Number.isFinite(n) ? usd.format(n) : "—";

export const PAGE_SIZE = 100;

type Filter = "all" | Bucket;

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "review", label: "Needs review" },
  { id: "ready", label: "Ready" },
  { id: "failed", label: "Failed" },
];

function LandedCostPanel({ goods, duty, inputs, onChange, partial }: { goods: number; duty: number; inputs: LandedCostInputs; onChange: (costs: LandedCostInputs) => void; partial: boolean }) {
  const [open, setOpen] = useState(false);
  let result = null, error = "";
  try { result = landedCost(goods, duty, inputs); } catch (e) { error = (e as Error).message; }
  return <section className="mt-5 rounded border border-rule bg-paper p-4" aria-label="Landed cost estimate">
    <button type="button" className="flex w-full items-center justify-between text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
      <span><span className="eyebrow">Scenario tool</span><span className="mt-1 block text-[16px] font-semibold">Estimate landed cost</span></span>
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
      <div className="text-[12px] uppercase tracking-wide text-muted">{label}</div>
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
      <h4 className="lbl mb-1">{title}</h4>
      <ul className="list-disc space-y-0.5 pl-5 text-[13px]">
        {items.map((t, i) => <li key={i}>{t}</li>)}
      </ul>
    </div>
  );
}

function Detail({ line, submitted }: { line: AuditLine; submitted: number }) {
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
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-4">
        <div><dt className="lbl">Row</dt><dd className="mono">{line.row}</dd></div>
        <div><dt className="lbl">Origin</dt><dd>{line.country || "—"}</dd></div>
        <div>
          <dt className="lbl">Value</dt>
          <dd className="mono">{line.entered_value !== undefined ? money(line.entered_value) : submitted > 0 ? `${money(submitted)} (as entered)` : "—"}</dd>
        </div>
        <div>
          <dt className="lbl">Line duty, excl. MPF</dt>
          <dd className="mono">{line.duty !== undefined ? money(line.duty) : "not priced"}</dd>
        </div>
      </dl>

      {failed ? (
        <p className="rounded border-l-2 py-1.5 pl-3 border-danger bg-caution-soft text-danger">
          This line has no figures and is not in the totals.
        </p>
      ) : null}

      <List title={failed ? "What went wrong" : "Why this needs review"} items={reasons} />
      <List title="Duty is understated because" items={incomplete} />
      <List title="Warnings" items={warnings} />

      {scope.length ? (
        <div>
          <h4 className="lbl mb-1">Trade-remedy headings awaiting scope confirmation</h4>
          <p className="mono text-[13px]">
            {scope.map((h, i) => (
              <span key={h}>{i ? ", " : ""}<Link href={`/hts/${h}`} className="hover:underline text-accent">{h}</Link></span>
            ))}
          </p>
        </div>
      ) : null}

      {suggested.length ? (
        <div>
          <h4 className="lbl mb-1">Classifier candidates</h4>
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
                          </a>
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
          <h4 className="lbl mb-1">Sibling statistical lines with different rates</h4>
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
  );
}

export default function AuditResults({
  summary, lines, inputs, landedCosts, onCostsChange,
}: {
  landedCosts: LandedCostInputs;
  onCostsChange: (costs: LandedCostInputs) => void;
  summary: AuditSummary;
  lines: AuditLine[];
  /** The amount submitted for each line, shown where a line carries none. */
  inputs: number[];
}) {
  const counts = useMemo(() => countLines(lines), [lines]);
  const [filter, setFilter] = useState<Filter>("all");
  const [page, setPage] = useState(0);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("original");
  const [open, setOpen] = useState<Set<number>>(new Set());

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
  const filterCount: Record<Filter, number> = {
    all: counts.submitted, review: counts.review, ready: counts.ready, failed: counts.failed,
  };

  const toggle = (i: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(i)) next.add(i);
      return next;
    });

  return (
    <section className="space-y-5" aria-label="Audit results">
      <div className="flex flex-wrap items-end justify-between gap-3 border-t border-border pt-7">
        <div><p className="eyebrow">Your audit workspace</p><h2 className="serif mt-2 text-3xl tracking-tight">Review the details.</h2></div>
        <span className="text-xs text-muted">Open a row to inspect evidence and warnings</span>
      </div>
      <p className="text-[15px] font-medium" data-testid="reconciliation">
        Submitted <span className="mono">{counts.submitted.toLocaleString()}</span>
        {" · "}Ready <span className="mono">{counts.ready.toLocaleString()}</span>
        {" · "}Needs attention <span className="mono">{unresolved.toLocaleString()}</span>
      </p>
      <p className="-mt-3 text-[13px] text-muted">
        Ready means priced, complete, and nothing left to confirm.
        {unresolved > 0
          ? ` Needs attention is every other line: ${counts.review.toLocaleString()} priced but to be confirmed, and ${counts.failed.toLocaleString()} that could not be priced.`
          : " Every line is priced and complete."}
      </p>

      {summary.truncated ? (
        <p className="rounded border-l-2 py-2 pl-3 text-[14px] border-caution bg-caution-soft text-caution-ink">
          The time budget for one run was reached, so some lines were not processed. They are listed below as
          “Not processed” and are not in the totals. Run the remainder as a separate catalogue.
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Metric
          label="Entered value"
          value={money(summary.entered_value)}
          sub={`${summary.priced.toLocaleString()} of ${counts.submitted.toLocaleString()} lines priced`}
          partial={partial ? unresolved : undefined}
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
          partial={partial ? unresolved : undefined}
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
      <p className="-mt-3 text-[11px] text-faint">
        Reference data revision:{" "}
        <span className="mono">{summary.dataset_revision || "not reported"}</span>
      </p>

      <div className="panel space-y-4 p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <label className="flex-1 space-y-1.5"><span className="text-xs font-medium">Find a product</span><input type="search" value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }} placeholder="Search SKU, description, code, or origin" className="field-control" /></label>
        <label className="space-y-1.5 sm:w-52"><span className="text-xs font-medium">Sort results</span><select value={sort} onChange={(event) => { setSort(event.target.value); setPage(0); }} className="field-control"><option value="original">Original row order</option><option value="duty">Highest duty first</option><option value="value">Highest value first</option></select></label>
      </div>
      <div role="group" aria-label="Filter lines" className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={filter === f.id}
            onClick={() => { setFilter(f.id); setPage(0); }}
            className={`rounded border px-3 py-1.5 text-[13px] font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
              filter === f.id ? "border-accent bg-accent-soft text-accent" : "border-rule text-muted"
            }`}
          >
            {f.label} <span className="mono">({filterCount[f.id].toLocaleString()})</span>
          </button>
        ))}
      </div>

      <p role="status" className="text-xs text-muted">{shown.length.toLocaleString()} of {lines.length.toLocaleString()} products match</p>
      </div>

      {!shown.length ? (
        <div className="panel px-5 py-10 text-center"><p className="font-medium">No products match this view</p><p className="mt-2 text-sm text-muted">Try a different search or show all review statuses.</p><button type="button" onClick={() => { setQuery(""); setFilter("all"); setPage(0); }} className="btn btn-secondary mt-5">Clear search and filters</button></div>
      ) : (
        <div className="panel overflow-hidden">
          <p className="border-b border-border px-4 py-2 text-xs text-muted md:hidden">Scroll across to see every column. Open Details to review a product.</p>
          <div className="scroll-x relative" tabIndex={0} role="region" aria-label="Audited products">
          <table className="data-table w-full min-w-[520px] text-[14px] md:min-w-[860px]">
            <caption className="sr-only">
              Audited lines, {shown.length} shown, page {at + 1} of {pages}
            </caption>
            <thead>
              <tr className="border-b text-left border-border text-faint">
                <th scope="col" className="hidden py-2 pr-3 font-medium md:table-cell">Row</th>
                <th scope="col" className="py-2 pr-3 font-medium">Product</th>
                <th scope="col" className="hidden py-2 pr-3 font-medium md:table-cell">HTS</th>
                <th scope="col" className="hidden py-2 pr-3 font-medium md:table-cell">Origin</th>
                <th scope="col" className="hidden py-2 pr-3 text-right font-medium sm:table-cell">Value</th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">Duty</th>
                <th scope="col" className="py-2 pl-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {slice.map(({ line: l, i }) => {
                const expanded = open.has(i);
                const detailId = `line-detail-${i}`;
                const value = l.entered_value ?? (inputs[i] > 0 ? inputs[i] : undefined);
                return (
                  <Fragment key={i}>
                    <tr className="border-b align-top border-hair">
                      <td className="mono hidden py-2 pr-3 text-[13px] text-muted md:table-cell">{l.row}</td>
                      <td className="max-w-[28rem] py-2 pr-3">
                        <div className="flex items-baseline gap-2">
                          <span className="mono text-[13px] text-faint md:hidden">#{l.row}</span>
                          <span className="mono text-[13px] font-medium">{l.sku || "no SKU"}</span>
                        </div>
                        <div className="text-muted">{l.description || "—"}</div>
                        <div className="mono mt-0.5 text-[12px] text-faint md:hidden">
                          {l.hts ?? "no code"} · {l.country || "no origin"}
                          {value !== undefined ? ` · ${money(value)}` : ""}
                        </div>
                      </td>
                      <td className="mono hidden py-2 pr-3 text-[13px] md:table-cell">
                        {l.hts ? (
                          <Link href={`/hts/${l.hts}?country=${encodeURIComponent(l.country || "")}`} className="hover:underline text-accent">{l.hts}</Link>
                        ) : "—"}
                      </td>
                      <td className="hidden py-2 pr-3 text-muted md:table-cell">{l.country || "—"}</td>
                      <td className={`mono hidden py-2 pr-3 text-right sm:table-cell ${l.entered_value === undefined ? "text-faint" : ""}`}>
                        {money(value)}
                      </td>
                      <td className="mono py-2 pr-3 text-right">
                        {l.duty !== undefined ? money(l.duty) : "—"}
                      </td>
                      <td className="py-2 pl-2">
                        <div className="flex flex-col items-start gap-1">
                          <StatusChip status={l.status} />
                          <button
                            type="button"
                            aria-expanded={expanded}
                            aria-controls={detailId}
                            onClick={() => toggle(i)}
                            className="text-[12px] hover:underline text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                          >
                            {expanded ? "Hide details" : "Details"}
                            <span className="sr-only"> for row {l.row}</span>
                          </button>
                        </div>
                      </td>
                    </tr>
                    {expanded ? (
                      <tr id={detailId} className="border-b border-hair bg-sunk">
                        <td colSpan={7} className="px-2">
                          <Detail line={l} submitted={inputs[i] ?? 0} />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          </div>
        </div>
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
    </section>
  );
}
