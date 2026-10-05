import Link from "next/link";
import SavedCosts from "@/components/SavedCosts";
import ReviewWorkspace from "@/components/ReviewWorkspace";
import { EMPTY_COSTS, parseCosts } from "@/lib/landedCost";
import { notFound } from "next/navigation";
import { requireViewer } from "@/lib/auth";
import { repriceCatalogueAction } from "@/lib/actions";
import {
  catalogueTotals, countCatalogueWatches, getCatalogue, itemUnresolved,

} from "@/lib/catalogues";
import { money2 } from "@/lib/api";
import { Card } from "@/components/ui";
import { PartialMark } from "@/components/status";
import LineList from "@/components/LineList";
import LineControls from "@/components/LineControls";
import { LEGACY_LABEL, bucketOf, countLines, isPriced, reviewNotes } from "@/lib/auditModel";
import { APPROVAL_LABEL, approvalCounts } from "@/lib/review";
import { LineFilterTabs, LineSummary, LINE_FILTERS, type LineFilterId } from "@/components/LineSummary";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 100;
type Show = LineFilterId;

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", {
    year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    timeZone: "UTC", timeZoneName: "short",
  }) : null;

function Metric({
  label, value, sub, partial, tone,
}: { label: string; value: string; sub?: string; partial?: number; tone?: "recover" }) {
  return (
    <Card>
      <div className="text-[13px] font-medium text-muted">{label}</div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className={`mono text-2xl font-semibold ${tone === "recover" ? "text-recover" : ""}`}>{value}</span>
        {partial ? <PartialMark unresolved={partial} /> : null}
      </div>
      {sub ? <div className="mt-1 text-[12px] text-muted">{sub}</div> : null}
    </Card>
  );
}

export default async function CataloguePage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ show?: string; page?: string; q?: string; sort?: string; saved?: string; repriced?: string; changed?: string; unchanged?: string; repriceError?: string }>;
}) {
  const { id } = await params;
  const viewer = await requireViewer(`/catalogues/${id}`);
  const sp = await searchParams;
  const cat = await getCatalogue(viewer.account.id, id);
  if (!cat) notFound();

  const legacy = cat.items.length > 0 && cat.items.every((i) => i.status === null);
  const totals = catalogueTotals(cat.items, cat.mpf);
  const counts = countLines(cat.items.map((i) => ({ status: i.status ?? "ready" })));
  const unresolved = cat.items.filter(itemUnresolved).length;
  const partial = cat.totals_complete === 0;
  const watches = await countCatalogueWatches(viewer.account.id, cat.id);

  const show: Show = LINE_FILTERS.some((s) => s.id === sp.show) ? (sp.show as Show) : "all";
  type Sort = "unresolved" | "original" | "duty" | "value";
  const sort: Sort = sp.sort === "original" || sp.sort === "duty" || sp.sort === "value" ? sp.sort : "unresolved";
  // Unresolved lines first by default: they are the work, and a saved
  // catalogue that buries them under a thousand ready lines has lost them
  // again. Original row order, highest duty, and highest value are also
  // offered, mirroring the pre-save audit view's own sort options.
  const ordered = cat.items
    .map((item, n) => ({ item, n }))
    .sort((a, b) => {
      if (sort === "original") return a.n - b.n;
      if (sort === "duty") return (b.item.duty ?? -1) - (a.item.duty ?? -1);
      if (sort === "value") return (b.item.value ?? -1) - (a.item.value ?? -1);
      return Number(itemUnresolved(b.item)) - Number(itemUnresolved(a.item)) || a.n - b.n;
    })
    .map((x) => x.item);
  const query = (sp.q ?? "").trim().toLowerCase();
  const filtered = ordered.filter((i) => {
    if (show !== "all") {
      const showMatch = i.status === null ? (show === "review" ? itemUnresolved(i) : !itemUnresolved(i)) : bucketOf(i.status) === show;
      if (!showMatch) return false;
    }
    if (!query) return true;
    return [i.sku, i.description, i.country, i.hts].some((v) => v?.toLowerCase().includes(query));
  });
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const at = Math.min(Math.max(1, Number(sp.page) || 1), pages);
  const slice = filtered.slice((at - 1) * PAGE_SIZE, at * PAGE_SIZE);

  const href = (s: Show, p = 1) => {
    const q = new URLSearchParams();
    if (s !== "all") q.set("show", s);
    if (p > 1) q.set("page", String(p));
    if (sp.q) q.set("q", sp.q);
    if (sort !== "unresolved") q.set("sort", sort);
    const qs = q.toString();
    return `/catalogues/${cat.id}${qs ? `?${qs}` : ""}`;
  };
  const filterCount: Record<Show, number> = legacy
    ? { all: cat.items.length, review: unresolved, ready: cat.items.length - unresolved, failed: 0 }
    : { all: counts.submitted, review: counts.review, ready: counts.ready, failed: counts.failed };

  const calculated = when(cat.calculated_at);
  const approval = approvalCounts(cat.items.map((i) => ({ approval_status: i.review_status })));
  const pendingReview = approval.pending;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1.5">
          <Link href="/catalogues" className="text-[13px] hover:underline text-faint">
            ← Catalogues
          </Link>
          <h1 className="serif text-3xl tracking-tight">{cat.name}</h1>
          <p className="text-[13px] text-faint">
            {cat.items.length.toLocaleString()} products · {watches.toLocaleString()}{" "}
            {watches === 1 ? "code" : "codes"} watched
            {legacy ? "" : " · lines that could not be priced are kept here but not watched"}
          </p>
        </div>
        {/* One primary action: the human review that is waiting. Everything
            else is secondary, so the eye has a single place to go. */}
        <div className="flex flex-wrap items-center gap-2">
          <Link href={`/catalogues/${cat.id}/review`} className="btn btn-primary">
            {pendingReview > 0
              ? `Review ${pendingReview.toLocaleString()} ${pendingReview === 1 ? "product" : "products"}`
              : "Review classifications"}
          </Link>
          <details className="relative">
            <summary className="btn btn-secondary cursor-pointer list-none">Export</summary>
            <div className="absolute right-0 z-10 mt-2 grid w-64 gap-1 rounded-[var(--radius-panel)] border border-rule bg-surface p-2 shadow-lg">
              <a href={`/api/catalogues/export?id=${cat.id}`} className="rounded px-3 py-2 text-[14px] hover:bg-sunk">Export CSV</a>
              <a href={`/api/catalogues/evidence?id=${cat.id}`} className="rounded px-3 py-2 text-[14px] hover:bg-sunk">Evidence package</a>
              <Link href={`/catalogues/${cat.id}/report`} className="rounded px-3 py-2 text-[14px] hover:bg-sunk">Printable report</Link>
            </div>
          </details>
          <form action={repriceCatalogueAction}>
            <input type="hidden" name="id" value={cat.id} />
            <button className="btn btn-secondary">
              Re-price with current rates
            </button>
          </form>
        </div>
      </div>

      {sp.saved ? (
        <p role="status" className="border-l-2 py-2 pl-3 text-[14px] border-accent bg-accent-soft text-accent">
          Saved as <strong>{cat.name}</strong>.{" "}
          {watches === 0
            ? "None of its lines has a code that can be watched yet."
            : `${watches === 1 ? "Its one code is" : `Its ${watches.toLocaleString()} codes are`} now watched.`}
        </p>
      ) : null}
      {sp.repriced ? (
        <p role="status" className="border-l-2 py-2 pl-3 text-[14px] border-accent bg-accent-soft text-accent">
          Re-priced against today&rsquo;s reference data. {sp.changed} of{" "}
          {Number(sp.changed || 0) + Number(sp.unchanged || 0)} lines changed
          {Number(sp.changed) > 0 ? " — any that were approved and changed are back to pending review." : "."}
        </p>
      ) : null}
      {sp.repriceError ? (
        <p role="alert" className="border-l-2 py-2 pl-3 text-[14px] border-danger bg-caution-soft text-danger">
          Could not re-price: {sp.repriceError}
        </p>
      ) : null}

      {legacy ? (
        <p className="rounded border-l-2 py-2 pl-3 text-[14px] border-caution bg-caution-soft text-caution-ink">
          <strong>{LEGACY_LABEL}.</strong> This catalogue was saved when only priced lines were kept, so it
          cannot say whether its totals were complete, and it has no record of lines that failed. Run the
          audit again and save it to get the full review record.
        </p>
      ) : (
        <LineSummary
          pendingReview={pendingReview}
          submitted={counts.submitted}
          unresolved={counts.unresolved}
          duty={totals.duty}
          partial={partial || counts.unresolved > 0}
          review={counts.review}
          failed={counts.failed}
          ready={counts.ready}
        />
      )}

      <details className="border-t border-border pt-4">
        <summary className="cursor-pointer text-[14px] font-medium text-accent">Totals, refund estimate and assumptions</summary>
        <div className="mt-4 space-y-5">
          <p className="text-[13px] text-faint" data-testid="history">
            Saved {when(cat.created_at)}
            {cat.updated_at !== cat.created_at ? ` · last changed ${when(cat.updated_at)}` : ""}
          </p>
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            <Metric
              label="Entered value"
              value={money2(totals.value)}
              sub={legacy ? undefined : `${cat.items.filter((i) => i.status && isPriced(i.status)).length.toLocaleString()} of ${cat.items.length.toLocaleString()} lines priced`}
              partial={partial ? unresolved : undefined}
            />
            <Metric
              label="Duty and fees"
              value={money2(totals.duty)}
              sub={`${totals.ratePct.toFixed(2)}% effective${cat.mpf ? ` · includes ${money2(cat.mpf)} MPF` : legacy ? " · MPF not recorded" : ""}`}
              partial={partial ? unresolved : undefined}
            />
            <Metric
              label="Potentially refundable"
              value={money2(totals.refundable)}
              sub={totals.refundable > 0 ? "Estimate: IEEPA duties struck down, not a filed claim" : "none identified"}
              tone={totals.refundable > 0 ? "recover" : undefined}
              partial={partial ? unresolved : undefined}
            />
            <Metric
              label="Needs review"
              value={unresolved.toLocaleString()}
              sub={legacy ? "scope unverified" : `${counts.review.toLocaleString()} to review · ${counts.failed.toLocaleString()} failed`}
            />
          </div>

        <div className="space-y-2 text-[13px]">
            {calculated ? (
              <p className="text-muted">
                Calculated <span className="nb">{calculated}</span>
                {" · "}reference data revision{" "}
                <span className="mono">{cat.dataset_revision || "not reported"}</span>
              </p>
            ) : null}
            {cat.assumptions.length ? (
              <details>
                <summary className="cursor-pointer text-muted hover:underline">
                  Assumptions behind these figures ({cat.assumptions.length})
                </summary>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">
                  {cat.assumptions.map((a, i) => <li key={i}>{a}</li>)}
                </ul>
              </details>
            ) : null}
          </div>
        </div>
      </details>

      <LineFilterTabs
        counts={filterCount}
        active={show}
        hrefFor={(id) => href(id)}
      />

      <LineControls basePath={`/catalogues/${cat.id}`} show={show} sort={sort} q={sp.q ?? ""} />

      {!slice.length ? (
        <p className="py-6 text-[14px] text-muted">No lines match this filter.</p>
      ) : (
        <LineList
          label="Saved lines"
          caption={`Saved lines, unresolved first. Page ${at} of ${pages}.`}
          lines={slice.map((i) => ({
            key: i.id,
            row: i.row_number,
            sku: i.sku,
            description: i.description,
            country: i.country,
            hts: i.hts,
            value: i.status && !isPriced(i.status) && !i.value ? null : i.value,
            duty: i.duty,
            status: i.status,
            review: APPROVAL_LABEL[i.review_status],
            scopeUnverified: i.scope_unverified === 1,
            notes: reviewNotes({
              error: i.error, review_reasons: i.review,
              incomplete: i.incomplete, warnings: i.warnings,
            }),
          }))}
        />
      )}

      <ReviewWorkspace items={cat.items} />

      {pages > 1 ? (
        <nav aria-label="Pages" className="flex flex-wrap items-center gap-3 text-[13px]">
          {at > 1 ? (
            <Link href={href(show, at - 1)} className="rounded border px-3 py-1.5 border-rule">Previous</Link>
          ) : null}
          <span className="text-muted">
            Lines {(at - 1) * PAGE_SIZE + 1}–{Math.min(at * PAGE_SIZE, filtered.length)} of {filtered.length.toLocaleString()}
          </span>
          {at < pages ? (
            <Link href={href(show, at + 1)} className="rounded border px-3 py-1.5 border-rule">Next</Link>
          ) : null}
        </nav>
      ) : null}

      <SavedCosts id={cat.id} initial={cat.landed_cost_json ? parseCosts(JSON.parse(cat.landed_cost_json)) : EMPTY_COSTS} goods={totals.value} duty={totals.duty} partial={cat.totals_complete !== 1} items={cat.items} mpf={cat.mpf} />
    </div>
  );
}
