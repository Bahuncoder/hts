"use client";

import { Fragment, useState, type ReactNode } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui";
import { StatusChip } from "@/components/status";
import type { Status } from "@/lib/auditModel";

/** The one product list for a set of lines. The audit result and a saved
 *  catalogue both render it: the same cards on a phone, the same table at
 *  md and up, the same status chip and the same Details disclosure. What
 *  opens under Details differs: the audit shows its row editor, a saved line
 *  shows the reasons it needs attention. */

export type ListLine = {
  key: string;
  row: number | null;
  sku: string | null;
  description: string | null;
  country: string | null;
  hts: string | null;
  /** null when the file did not state a value, or it is not shown. */
  value: number | null;
  duty: number | null;
  status: Status | null;
  scopeUnverified?: boolean;
  /** Read-only reasons, shown under Details when there is no custom detail. */
  notes?: string[];
};

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const money = (n: number | null | undefined) =>
  typeof n === "number" && Number.isFinite(n) ? usd.format(n) : "—";

function Chevron({ open }: { open: boolean }) {
  return (
    <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12"
      className={`ml-1 inline-block transition-transform ${open ? "rotate-180" : ""}`}>
      <path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function EstimateCell({ line }: { line: ListLine }) {
  if (line.status === null && line.scopeUnverified) return <Badge tone="warn">Scope unverified</Badge>;
  return <StatusChip status={line.status} />;
}

export default function LineList({
  lines, caption, label, renderDetail,
}: {
  lines: ListLine[];
  /** Describes the table to screen readers, e.g. the page and count shown. */
  caption: string;
  /** Names the region, e.g. "Audited products" or "Saved lines". */
  label: string;
  /** Custom content under Details. When absent, a line's notes are shown. */
  renderDetail?: (key: string) => ReactNode;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const hasDetail = (l: ListLine) => Boolean(renderDetail) || Boolean(l.notes?.length);
  const detailFor = (l: ListLine): ReactNode =>
    renderDetail ? renderDetail(l.key) : (
      <ul className="list-disc space-y-1 py-3 pl-5 text-[13px] text-muted">
        {(l.notes ?? []).map((n, i) => <li key={i}>{n}</li>)}
      </ul>
    );

  return (
    <div>
      <div className="space-y-3 md:hidden" aria-label={label}>
        {lines.map((l) => {
          const expanded = open.has(l.key);
          const detailId = `line-card-detail-${l.key}`;
          return (
            <div key={l.key} className="panel min-w-0 break-words p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="mono text-[12px] text-faint">Row {l.row ?? "—"}{l.country ? ` · ${l.country}` : ""}</p>
                  <p className="mono mt-1 text-[14px] font-medium">{l.sku || "no SKU"}</p>
                  <p className="text-[14px] text-muted">{l.description || "—"}</p>
                </div>
                <div className="shrink-0"><EstimateCell line={l} /></div>
              </div>
              <dl className="mt-3 grid grid-cols-3 gap-2 text-[13px]">
                <div><dt className="text-faint">HTS</dt><dd className="mono whitespace-nowrap text-[12px]">{l.hts ?? "—"}</dd></div>
                <div><dt className="text-faint">Value</dt><dd className="mono">{money(l.value)}</dd></div>
                <div><dt className="text-faint">Duty</dt><dd className="mono">{money(l.duty)}</dd></div>
              </dl>
              {hasDetail(l) ? (
                <>
                  <button
                    type="button"
                    aria-expanded={expanded}
                    aria-controls={detailId}
                    onClick={() => toggle(l.key)}
                    className="mt-3 text-[12px] hover:underline text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    {expanded ? "Hide details" : "Details"}<Chevron open={expanded} />
                    <span className="sr-only"> for row {l.row ?? ""}</span>
                  </button>
                  {expanded ? <div id={detailId} className="mt-2">{detailFor(l)}</div> : null}
                </>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="scroll-x panel relative hidden overflow-hidden md:block" tabIndex={0} role="region" aria-label={`${label} table`}>
        <table className="data-table w-full min-w-[520px] text-[14px] md:min-w-[860px]">
          <caption className="sr-only">{caption}</caption>
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
            {lines.map((l) => {
              const expanded = open.has(l.key);
              const detailId = `line-detail-${l.key}`;
              return (
                <Fragment key={l.key}>
                  <tr className="border-b align-top border-hair">
                    <td className="mono hidden py-2 pr-3 text-[13px] text-muted md:table-cell">{l.row ?? "—"}</td>
                    <td className="max-w-[28rem] py-2 pr-3">
                      <div className="flex items-baseline gap-2">
                        <span className="mono text-[13px] text-faint md:hidden">#{l.row ?? "—"}</span>
                        <span className="mono text-[13px] font-medium">{l.sku || "no SKU"}</span>
                      </div>
                      <div className="text-muted">{l.description || "—"}</div>
                      <div className="mono mt-0.5 text-[12px] text-faint md:hidden">
                        {l.hts ?? "no code"} · {l.country || "no origin"}
                        {l.value !== null ? ` · ${money(l.value)}` : ""}
                      </div>
                    </td>
                    <td className="mono hidden py-2 pr-3 text-[13px] md:table-cell">
                      {l.hts ? (
                        <Link href={`/hts/${l.hts}?country=${encodeURIComponent(l.country || "")}`} className="hover:underline text-accent">{l.hts}</Link>
                      ) : "—"}
                    </td>
                    <td className="hidden py-2 pr-3 text-muted md:table-cell">{l.country || "—"}</td>
                    <td className={`mono hidden py-2 pr-3 text-right sm:table-cell ${l.value === null ? "text-faint" : ""}`}>
                      {money(l.value)}
                    </td>
                    <td className="mono py-2 pr-3 text-right">{money(l.duty)}</td>
                    <td className="py-2 pl-2">
                      <div className="flex flex-col items-start gap-1">
                        <EstimateCell line={l} />
                        {hasDetail(l) ? (
                          <button
                            type="button"
                            aria-expanded={expanded}
                            aria-controls={detailId}
                            onClick={() => toggle(l.key)}
                            className="text-[12px] hover:underline text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                          >
                            {expanded ? "Hide details" : "Details"}<Chevron open={expanded} />
                            <span className="sr-only"> for row {l.row ?? ""}</span>
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                  {expanded && hasDetail(l) ? (
                    <tr id={detailId} className="border-b border-hair bg-sunk">
                      <td colSpan={7} className="px-2">{detailFor(l)}</td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
