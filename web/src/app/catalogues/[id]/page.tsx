import Link from "next/link";
import SavedCosts from "@/components/SavedCosts";
import ReviewWorkspace from "@/components/ReviewWorkspace";
import { EMPTY_COSTS, parseCosts } from "@/lib/landedCost";
import { notFound, redirect } from "next/navigation";
import { currentViewer } from "@/lib/auth";
import { repriceCatalogueAction } from "@/lib/actions";
import {
  catalogueTotals, countCatalogueWatches, getCatalogue, itemUnresolved,
  type CatalogueItem,
} from "@/lib/catalogues";
import { money2 } from "@/lib/api";
import { Badge, Card } from "@/components/ui";
import { PartialMark, StatusChip } from "@/components/status";
import { LEGACY_LABEL, bucketOf, countLines, isPriced, reviewNotes } from "@/lib/auditModel";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 100;
type Show = "all" | "review" | "ready" | "failed";
const SHOWS: { id: Show; label: string }[] = [
  { id: "all", label: "All" },
  { id: "review", label: "Needs review" },
  { id: "ready", label: "Ready" },
  { id: "failed", label: "Failed" },
];

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
      <div className="text-[12px] uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className={`mono text-2xl font-semibold ${tone === "recover" ? "text-recover" : ""}`}>{value}</span>
        {partial ? <PartialMark unresolved={partial} /> : null}
      </div>
      {sub ? <div className="mt-1 text-[12px] text-muted">{sub}</div> : null}
    </Card>
  );
}

function Notes({ item }: { item: CatalogueItem }) {
  const notes = reviewNotes({
    error: item.error, review_reasons: item.review,
    incomplete: item.incomplete, warnings: item.warnings,
  });
  if (!notes.length) return null;
  return (
    <details className="mt-1 text-[12px]">
      <summary className="cursor-pointer text-accent hover:underline">
        Details<span className="sr-only"> for row {item.row_number ?? ""}</span>
      </summary>
      <ul className="mt-1 max-w-[26rem] list-disc space-y-1 pl-4 text-muted">
        {notes.map((n, i) => <li key={i}>{n}</li>)}
      </ul>
    </details>
  );
}

export default async function CataloguePage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ show?: string; page?: string; repriced?: string; changed?: string; unchanged?: string; repriceError?: string }>;
}) {
  const viewer = await currentViewer();
  if (!viewer) redirect("/login");
  const { id } = await params;
  const sp = await searchParams;
  const cat = await getCatalogue(viewer.account.id, id);
  if (!cat) notFound();

  const legacy = cat.items.length > 0 && cat.items.every((i) => i.status === null);
  const totals = catalogueTotals(cat.items, cat.mpf);
  const counts = countLines(cat.items.map((i) => ({ status: i.status ?? "ready" })));
  const unresolved = cat.items.filter(itemUnresolved).length;
  const partial = cat.totals_complete === 0;
  const watches = await countCatalogueWatches(viewer.account.id, cat.id);

  const show: Show = SHOWS.some((s) => s.id === sp.show) ? (sp.show as Show) : "all";
  // Unresolved lines first: they are the work, and a saved catalogue that
  // buries them under a thousand ready lines has lost them again.
  const ordered = cat.items
    .map((item, n) => ({ item, n }))
    .sort((a, b) =>
      Number(itemUnresolved(b.item)) - Number(itemUnresolved(a.item)) || a.n - b.n)
    .map((x) => x.item);
  const filtered = ordered.filter((i) => {
    if (show === "all") return true;
    if (i.status === null) return show === "review" ? itemUnresolved(i) : !itemUnresolved(i);
    return bucketOf(i.status) === show;
  });
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const at = Math.min(Math.max(1, Number(sp.page) || 1), pages);
  const slice = filtered.slice((at - 1) * PAGE_SIZE, at * PAGE_SIZE);

  const href = (s: Show, p = 1) => {
    const q = new URLSearchParams();
    if (s !== "all") q.set("show", s);
    if (p > 1) q.set("page", String(p));
    const qs = q.toString();
    return `/catalogues/${cat.id}${qs ? `?${qs}` : ""}`;
  };
  const filterCount: Record<Show, number> = legacy
    ? { all: cat.items.length, review: unresolved, ready: cat.items.length - unresolved, failed: 0 }
    : { all: counts.submitted, review: counts.review, ready: counts.ready, failed: counts.failed };

  const calculated = when(cat.calculated_at);

  return (
    <div className="space-y-7">
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
        <a href={`/api/catalogues/export?id=${cat.id}`} className="btn btn-secondary">
          Export CSV
        </a>
        <a href={`/api/catalogues/evidence?id=${cat.id}`} className="btn btn-secondary">
          Evidence package
        </a>
        <form action={repriceCatalogueAction}>
          <input type="hidden" name="id" value={cat.id} />
          <button className="btn btn-secondary">
            Re-price with current rates
          </button>
        </form>
      </div>

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

      <SavedCosts id={cat.id} initial={cat.landed_cost_json ? parseCosts(JSON.parse(cat.landed_cost_json)) : EMPTY_COSTS} goods={totals.value} duty={totals.duty} partial={cat.totals_complete !== 1} items={cat.items} mpf={cat.mpf} />
      <ReviewWorkspace catalogueId={cat.id} items={cat.items} />
      <Link className="btn btn-secondary" href={`/catalogues/${cat.id}/report`}>View printable evidence report</Link>
      {legacy ? (
        <p className="rounded border-l-2 py-2 pl-3 text-[14px] border-caution bg-caution-soft text-caution-ink">
          <strong>{LEGACY_LABEL}.</strong> This catalogue was saved when only priced lines were kept, so it
          cannot say whether its totals were complete, and it has no record of lines that failed. Run the
          audit again and save it to get the full review record.
        </p>
      ) : (
        <>
          <p className="text-[15px] font-medium" data-testid="reconciliation">
            Submitted <span className="mono">{counts.submitted.toLocaleString()}</span>
            {" · "}Ready <span className="mono">{counts.ready.toLocaleString()}</span>
            {" · "}Needs attention <span className="mono">{counts.unresolved.toLocaleString()}</span>
          </p>
          <p className="-mt-5 text-[13px] text-muted">
            Ready means priced, complete, and nothing left to confirm. Needs attention is every other line:{" "}
            {counts.review.toLocaleString()} priced but to be confirmed, {counts.failed.toLocaleString()} that
            could not be priced.
          </p>
        </>
      )}

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

      <nav aria-label="Filter lines" className="flex flex-wrap gap-2">
        {SHOWS.filter((s) => !legacy || s.id !== "failed").map((s) => (
          <Link
            key={s.id}
            href={href(s.id)}
            aria-current={show === s.id ? "true" : undefined}
            className={`rounded border px-3 py-1.5 text-[13px] font-medium ${
              show === s.id ? "border-accent bg-accent-soft text-accent" : "border-rule text-muted"
            }`}
          >
            {s.label} <span className="mono">({filterCount[s.id].toLocaleString()})</span>
          </Link>
        ))}
      </nav>

      {!slice.length ? (
        <p className="py-6 text-[14px] text-muted">No lines match this filter.</p>
      ) : (
        <div className="scroll-x relative">
          <table className="w-full min-w-[820px] text-[14px]">
            <caption className="sr-only">
              Saved lines, unresolved first. Page {at} of {pages}.
            </caption>
            <thead>
              <tr className="border-b text-left border-border text-faint">
                <th scope="col" className="py-2 pr-3 font-medium">Row</th>
                <th scope="col" className="py-2 pr-3 font-medium">Product</th>
                <th scope="col" className="py-2 pr-3 font-medium">HTS</th>
                <th scope="col" className="py-2 pr-3 font-medium">Origin</th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">Value</th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">Duty</th>
                <th scope="col" className="py-2 pl-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {slice.map((i) => (
                <tr key={i.id} className="border-b align-top border-hair">
                  <td className="mono py-2 pr-3 text-[13px] text-muted">{i.row_number ?? "—"}</td>
                  <td className="max-w-[26rem] py-2 pr-3">
                    <div className="mono text-[13px] font-medium">{i.sku || "no SKU"}</div>
                    <div className="clamp-2 text-muted">{i.description}</div>
                  </td>
                  <td className="mono py-2 pr-3 text-[13px]">
                    {i.hts ? (
                      <Link href={`/hts/${i.hts}`} className="hover:underline text-accent">{i.hts}</Link>
                    ) : "—"}
                  </td>
                  <td className="py-2 pr-3 text-muted">{i.country || "—"}</td>
                  <td className={`mono py-2 pr-3 text-right ${i.status && !isPriced(i.status) ? "text-faint" : ""}`}>
                    {i.status && !isPriced(i.status) && !i.value ? "—" : money2(i.value)}
                  </td>
                  <td className="mono py-2 pr-3 text-right">
                    {i.duty !== null ? money2(i.duty) : "—"}
                  </td>
                  <td className="py-2 pl-2">
                    {i.status === null && i.scope_unverified ? (
                      <Badge tone="warn">Scope unverified</Badge>
                    ) : (
                      <StatusChip status={i.status} />
                    )}
                    <Notes item={i} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

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
    </div>
  );
}
