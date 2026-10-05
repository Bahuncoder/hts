import type { ReactNode } from "react";
import Link from "next/link";

/** The one summary and filter set for a list of product lines. The audit
 *  result and a saved catalogue both render these, so the numbers, words and
 *  controls read the same before and after saving. */

export type LineFilterId = "all" | "review" | "ready" | "failed";

export const LINE_FILTERS: { id: LineFilterId; label: string }[] = [
  { id: "all", label: "All" },
  { id: "review", label: "Needs information" },
  { id: "ready", label: "Complete" },
  { id: "failed", label: "Failed" },
];

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const money = (n: number) => (Number.isFinite(n) ? usd.format(n) : "—");
const n = (v: number) => v.toLocaleString();

export function LineFilterTabs({
  counts, active, hrefFor, onSelect, label = "Filter lines",
}: {
  counts: Record<LineFilterId, number>;
  active: LineFilterId;
  /** Server-rendered views link to a URL per filter. */
  hrefFor?: (id: LineFilterId) => string;
  /** Client views select in place. */
  onSelect?: (id: LineFilterId) => void;
  label?: string;
}) {
  const style = (on: boolean) =>
    `rounded border px-3 py-1.5 text-[13px] font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
      on ? "border-accent bg-accent-soft text-accent" : "border-rule text-muted"
    }`;
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-2">
      {LINE_FILTERS.map((f) => {
        const on = active === f.id;
        const body = <>{f.label} <span className="mono">({n(counts[f.id])})</span></>;
        return hrefFor ? (
          <Link key={f.id} href={hrefFor(f.id)} aria-current={on ? "true" : undefined} className={style(on)}>
            {body}
          </Link>
        ) : (
          <button key={f.id} type="button" aria-pressed={on} onClick={() => onSelect?.(f.id)} className={style(on)}>
            {body}
          </button>
        );
      })}
    </div>
  );
}

export function LineSummary({
  headingId, submitted, unresolved, duty, partial, review, failed, ready, pendingReview, action, aside,
}: {
  headingId?: string;
  submitted: number;
  unresolved: number;
  duty: number;
  /** True when the duty leaves something out: unresolved lines, or totals the engine did not mark complete. */
  partial: boolean;
  review: number;
  failed: number;
  ready: number;
  /** Saved catalogues only: products still awaiting a human decision. */
  pendingReview?: number;
  action?: ReactNode;
  aside?: ReactNode;
}) {
  const desktopHeading = unresolved > 0 ? (
    <><span className="mono">{n(unresolved)}</span> of <span className="mono">{n(submitted)}</span> products need attention</>
  ) : (
    <>All <span className="mono">{n(submitted)}</span> products are priced and complete</>
  );
  return (
    <section className="space-y-5" aria-label="Summary">
      <div className="flex flex-wrap items-end justify-between gap-3 border-t border-border pt-7">
        <h2 className="serif text-3xl tracking-tight" id={headingId}>
          {pendingReview !== undefined ? (
            <>
              <span className="md:hidden">
                <span className="mono">{n(ready)}</span> complete {ready === 1 ? "estimate" : "estimates"}
                <span className="mt-1 block text-[15px] font-normal text-muted">
                  <span className="mono">{n(pendingReview)}</span> pending review
                </span>
              </span>
              <span className="hidden md:inline">{desktopHeading}</span>
            </>
          ) : desktopHeading}
        </h2>
        {aside ? <span className="flex flex-wrap items-center gap-4 text-[13px] text-muted">{aside}</span> : null}
      </div>

      <div className="flex flex-wrap items-end justify-between gap-6">
        <div>
          <p className="text-[13px] text-muted">Estimated duty and fees</p>
          <p className="mono text-3xl font-semibold">{money(duty)}</p>
          <p className="mt-1 text-[13px] text-muted">
            {partial ? (
              <>
                <span className="md:hidden">includes {n(review)} still to confirm, excludes {n(failed)} unpriced.</span>
                <span className="hidden md:inline">includes {n(review)} priced line{review === 1 ? "" : "s"} still to confirm; leaves out {n(failed)} that could not be priced. Lines marked incomplete may understate duty.</span>
              </>
            ) : `covers all ${n(submitted)} products.`}
          </p>
        </div>
        {action}
      </div>

      <p className="text-[13px] text-muted" data-testid="reconciliation">
        Submitted <span className="mono">{n(submitted)}</span>
        {" · "}Complete <span className="mono">{n(ready)}</span>
        {" · "}Needs attention <span className="mono">{n(unresolved)}</span>
      </p>
    </section>
  );
}
