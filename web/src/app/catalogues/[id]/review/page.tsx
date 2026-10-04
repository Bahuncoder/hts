import { notFound } from "next/navigation";
import Link from "next/link";
import { requireViewer } from "@/lib/auth";
import { getCatalogue } from "@/lib/catalogues";
import { LEGACY_LABEL, STATUS_LABEL } from "@/lib/auditModel";
import {
  APPROVAL_LABEL, APPROVAL_STATUSES, approvalCounts, catalogueReviewState,
  isApprovalStatus, itemHistory, type ApprovalStatus,
} from "@/lib/review";
import { addCommentAction, assignItemAction, setApprovalAction } from "@/lib/reviewActions";
import { getDraft } from "@/lib/correction";
import { confirmCorrectionAction, proposeCorrectionAction } from "@/lib/correctionActions";
import { Badge, Card, HtsLink } from "@/components/ui";
import { classify, money2 } from "@/lib/api";
import { allow, CLASSIFY_LIMIT } from "@/lib/budget";
import { ORIGINS } from "@/lib/origins";
import { MAX_REVIEW_NOTE } from "@/lib/reviewModel";
import EvidenceSnapshot from "@/components/EvidenceSnapshot";

export const dynamic = "force-dynamic";
export const metadata = { title: "Review" };

const PAGE_SIZE = 100;

const TONE: Record<ApprovalStatus, string> = {
  pending: "text-muted",
  approved: "text-accent",
  changes_requested: "text-caution-ink",
  rejected: "text-danger",
};

type StatusFilter = "all" | ApprovalStatus;
const isStatusFilter = (v: unknown): v is StatusFilter => v === "all" || isApprovalStatus(v);
// "Pending" here, not APPROVAL_LABEL.pending ("Pending review") — the word
// "Review" in a filter pill collides with tests/review.test.mjs's
// `a:has-text("Review")` locator for the per-row open link.
const STATUS_FILTERS: { id: StatusFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "pending", label: "Pending" },
  { id: "approved", label: APPROVAL_LABEL.approved },
  { id: "changes_requested", label: APPROVAL_LABEL.changes_requested },
  { id: "rejected", label: APPROVAL_LABEL.rejected },
];

export default async function Review({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    item?: string; notice?: string; q?: string; page?: string; status?: string;
    compare?: string; pick?: string; proposal?: string; error?: string;
  }>;
}) {
  const { id } = await params;
  const viewer = await requireViewer(`/catalogues/${id}/review`);
  const sp = await searchParams;
  const cat = await getCatalogue(viewer.account.id, id);
  if (!cat) notFound();
  const state = await catalogueReviewState(viewer.account.id, id);
  const rows = cat.items.map((item) => ({
    item, review: state.get(item.id) ?? { id: item.id, approval_status: "pending" as ApprovalStatus, assigned_to: null },
  }));
  const counts = approvalCounts(rows.map((r) => r.review));

  const openId = sp.item;
  const open = openId ? rows.find((r) => r.item.id === openId) : undefined;
  const history = open ? await itemHistory(viewer.account.id, open.item.id) : [];

  const statusFilter: StatusFilter = isStatusFilter(sp.status) ? sp.status : "all";
  const q = (sp.q ?? "").trim().toLowerCase();
  const filtered = rows.filter(({ review, item }) => {
    if (statusFilter !== "all" && review.approval_status !== statusFilter) return false;
    if (!q) return true;
    return [item.sku, item.description, item.country, item.hts].some((v) => v?.toLowerCase().includes(q));
  });
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const at = Math.min(Math.max(1, Number(sp.page) || 1), pages);
  const slice = filtered.slice((at - 1) * PAGE_SIZE, at * PAGE_SIZE);
  const href = (p = 1, s: StatusFilter = statusFilter) => {
    const qp = new URLSearchParams();
    if (sp.q) qp.set("q", sp.q);
    if (s !== "all") qp.set("status", s);
    if (p > 1) qp.set("page", String(p));
    const qs = qp.toString();
    return `/catalogues/${cat.id}/review${qs ? `?${qs}` : ""}`;
  };
  // The first product still waiting for a decision, in queue order, opened
  // directly so the reviewer does not have to click a row first.
  const pendingRows = rows.filter((r) => r.review.approval_status === "pending");
  const startId = pendingRows[0]?.item.id;
  // Under the pending filter this product is first, so it is on page 1.
  const startHref = startId ? `/catalogues/${cat.id}/review?status=pending&item=${startId}` : "";
  const openHref = (itemId: string, p = at) => {
    const qp = new URLSearchParams();
    if (sp.q) qp.set("q", sp.q);
    if (statusFilter !== "all") qp.set("status", statusFilter);
    if (p > 1) qp.set("page", String(p));
    qp.set("item", itemId);
    return `/catalogues/${cat.id}/review?${qp.toString()}#row-${itemId}`;
  };

  // "Record decision and review next" — the next item, wrapping around the
  // current filtered queue, still pending; may live on a different page than
  // the one open now, so its real page index is computed, not assumed.
  let nextPendingId = "";
  let nextPendingPage = at;
  if (open) {
    const openIdx = filtered.findIndex((r) => r.item.id === open.item.id);
    const n = filtered.length;
    // Visit every OTHER index once, wrapping forward from the open item; if
    // the open item isn't in the current filtered view at all (its own
    // status just changed and no longer matches an active status filter —
    // already possible today with the `q` filter), scan the whole thing.
    const order = openIdx === -1
      ? Array.from({ length: n }, (_, i) => i)
      : Array.from({ length: n - 1 }, (_, step) => (openIdx + step + 1) % n);
    const idx = order.find((i) => filtered[i].review.approval_status === "pending");
    if (idx !== undefined) {
      nextPendingId = filtered[idx].item.id;
      nextPendingPage = Math.floor(idx / PAGE_SIZE) + 1;
    }
  }

  // A pending correction awaiting confirmation for the open item, if any --
  // expired or not-found drafts fall back to the edit form below rather than
  // a dead end.
  const draft = open && sp.proposal ? await getDraft(viewer.account.id, open.item.id, sp.proposal) : null;

  // "Compare candidates" only makes sense while editing, not while a draft
  // from a previous attempt is already awaiting confirmation.
  const comparing = !!(open && !draft && sp.compare);
  const candidateWait = comparing
    ? await allow("classify", `account:${viewer.account.id}`, CLASSIFY_LIMIT) : null;
  const candidateOutcome = comparing && candidateWait === null && open
    ? await classify(open.item.description) : null;

  // No #row-<id> anchor here, unlike openHref: this always targets the item
  // already open, and a fragment matching an id already on the page causes
  // Next's Link to treat the click as an in-page scroll and skip the
  // navigation entirely -- confirmed empirically, not merely suspected.
  const correctionHref = (extra: Record<string, string> = {}) => {
    if (!open) return "";
    const qp = new URLSearchParams();
    if (sp.q) qp.set("q", sp.q);
    if (statusFilter !== "all") qp.set("status", statusFilter);
    if (at > 1) qp.set("page", String(at));
    qp.set("item", open.item.id);
    for (const [k, v] of Object.entries(extra)) qp.set(k, v);
    return `/catalogues/${cat.id}/review?${qp.toString()}`;
  };

  return (
    <div className="space-y-6">
      {sp.notice === "conflict" && <p role="alert" className="text-caution-ink">The review could not be saved. This view has been refreshed: check for a newer decision. Unclassified or incomplete lines cannot be approved.</p>}
      {sp.notice === "queue_complete" && <p role="status" className="text-accent">Nice work — every item in this view has been reviewed.</p>}
      {sp.notice === "corrected" && <p role="status" className="text-accent">Correction applied. Review the new figures before approving.</p>}
      {sp.error && <p role="alert" className="text-caution-ink">{sp.error}</p>}
      <div className="space-y-1">
        <p className="text-[13px] text-muted">
          <Link href={`/catalogues/${cat.id}`} className="hover:underline">{cat.name}</Link> · Human review
        </p>
        <h1 className="serif text-3xl tracking-tight">Review {cat.name}</h1>
        <p className="text-[14px] text-muted">
          A calculation is not a sign-off. Record who checked each product, what they decided, and why —
          separate from what the engine computed.
        </p>
      </div>

      {/* The counts live on the filter tabs below, so they are shown once.
          The primary action is the next product still waiting for a decision. */}
      {startId ? (
        <div>
          <Link href={startHref} className="btn btn-primary">
            Start next pending review
          </Link>
        </div>
      ) : null}

      <div className={open ? "lg:grid lg:grid-cols-[minmax(0,1fr)_26rem] lg:gap-6 lg:items-start" : undefined}>
        <div
          className={open ? "hidden space-y-6 lg:block lg:max-h-[calc(100vh-7rem)] lg:overflow-y-auto lg:pr-1" : "space-y-6"}
          role={open ? "region" : undefined}
          aria-label={open ? "Review queue" : undefined}
        >
          <nav aria-label="Filter by review status" className="flex flex-wrap gap-2">
            {STATUS_FILTERS.map((f) => (
              <Link
                key={f.id}
                href={href(1, f.id)}
                aria-current={statusFilter === f.id ? "true" : undefined}
                className={`rounded border px-3 py-1.5 text-[13px] font-medium ${
                  statusFilter === f.id ? "border-accent bg-accent-soft text-accent" : "border-rule text-muted"
                }`}
              >
                {f.label} <span className="mono">({(f.id === "all" ? rows.length : counts[f.id]).toLocaleString()})</span>
              </Link>
            ))}
          </nav>

          <form method="get" action={`/catalogues/${cat.id}/review`} className="flex flex-wrap items-end gap-3">
            {statusFilter !== "all" ? <input type="hidden" name="status" value={statusFilter} /> : null}
            <label className="min-w-[16rem] flex-1 text-[13px]">
              Search
              <input data-search
                type="search" name="q" defaultValue={sp.q ?? ""} className="field-control mt-1 block w-full"
                placeholder="SKU, description, origin, or HTS code"
              />
            </label>
            <button type="submit" className="btn btn-secondary">Search</button>
          </form>

          {!slice.length ? (
            <p className="py-6 text-[14px] text-muted">No lines match this search.</p>
          ) : (
            <>
              <ul className="space-y-3 md:hidden" aria-label={`Products in ${cat.name}`}>
                {slice.map(({ item, review }) => (
                  <li key={item.id} className={`panel p-4 ${item.id === openId ? "border-accent" : ""}`}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="mono text-[12px] text-faint">Row {item.row_number ?? "—"}</p>
                        <p className="mt-1 text-[15px] font-medium">{item.description || "—"}</p>
                        <p className="mt-1 text-[13px] text-muted">
                          {item.country} · <span className="mono">{item.hts ?? "Unclassified"}</span>
                        </p>
                      </div>
                      <span className={`shrink-0 text-[13px] font-medium ${TONE[review.approval_status]}`}>
                        {APPROVAL_LABEL[review.approval_status]}
                      </span>
                    </div>
                    <Link href={openHref(item.id)} className="mt-2 inline-flex min-h-[44px] items-center text-[14px] font-medium text-accent hover:underline">
                      Open product
                    </Link>
                  </li>
                ))}
              </ul>
            <Card className="hidden md:block">
              <div className="scroll-x">
                <table className="data-table w-full min-w-[720px] text-[14px]">
                  <caption className="sr-only">Products in {cat.name} with their review status. Page {at} of {pages}.</caption>
                  <thead>
                    <tr>
                      <th scope="col">Row</th>
                      <th scope="col">Product</th>
                      <th scope="col">Origin</th>
                      <th scope="col">HTS</th>
                      <th scope="col">Calculation</th>
                      <th scope="col">Review</th>
                      <th scope="col">Assigned to</th>
                      <th scope="col" className="sr-only">Open</th>
                    </tr>
                  </thead>
                  <tbody>
                    {slice.map(({ item, review }) => (
                      <tr key={item.id} id={`row-${item.id}`} className={item.id === openId ? "bg-sunk" : undefined}>
                        <td className="mono">{item.row_number ?? "—"}</td>
                        <td>{item.description || "—"}</td>
                        <td>{item.country}</td>
                        <td className="mono">{item.hts ?? "Unclassified"}</td>
                        <td>{item.status ? STATUS_LABEL[item.status] : LEGACY_LABEL}</td>
                        <td className={TONE[review.approval_status]}>{APPROVAL_LABEL[review.approval_status]}</td>
                        <td>{review.assigned_to || "—"}</td>
                        <td>
                          <Link href={openHref(item.id)} className="text-accent hover:underline">
                            {item.id === openId ? "Open" : "Review"}
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
            </>
          )}

          {pages > 1 ? (
            <nav aria-label="Pages" className="flex flex-wrap items-center gap-3 text-[13px]">
              {at > 1 ? (
                <Link href={href(at - 1)} className="rounded border px-3 py-1.5 border-rule">Previous</Link>
              ) : null}
              <span className="text-muted">
                Lines {(at - 1) * PAGE_SIZE + 1}–{Math.min(at * PAGE_SIZE, filtered.length)} of {filtered.length.toLocaleString()}
              </span>
              {at < pages ? (
                <Link href={href(at + 1)} className="rounded border px-3 py-1.5 border-rule">Next</Link>
              ) : null}
            </nav>
          ) : null}
        </div>

        {open ? (
          <div
            className="mt-6 lg:mt-0 lg:sticky lg:top-6 lg:max-h-[calc(100vh-3rem)] lg:overflow-y-auto"
            role="region" aria-label="Selected product"
          >
            <Link href={href(at)} className="mb-3 inline-block text-[13px] hover:underline text-faint lg:hidden">
              ← Back to review queue
            </Link>
            <Card>
              <div className="space-y-5">
                <div>
                  <h2 className="serif text-xl">
                    Row {open.item.row_number ?? "—"} — {open.item.description || "Unnamed product"}
                  </h2>
                  <p className="text-[13px] text-muted">
                    {open.item.country} · {open.item.hts ?? "Unclassified"}
                    {open.item.duty !== null ? ` · Duty ${money2(open.item.duty)}` : ""}
                  </p>
                </div>

                <EvidenceSnapshot json={open.item.evidence_json} />

                <details className="rounded border border-rule p-4">
                  <summary className="cursor-pointer text-[13px] font-medium text-accent">Correct this line</summary>
                  <div className="mt-4 space-y-4">
                    {draft ? (
                      <div className="space-y-4">
                        <p className="text-[13px] text-muted">Recalculated — review the change before confirming.</p>
                        <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-[13px]">
                          <div><p className="lbl">HTS</p><p className="mono mt-1">{open.item.hts ?? "Unclassified"} → {draft.line.hts ?? "Unclassified"}</p></div>
                          <div><p className="lbl">Country</p><p className="mt-1">{open.item.country} → {draft.overrides.country ?? open.item.country}</p></div>
                          <div><p className="lbl">Value</p><p className="mono mt-1">{money2(open.item.value)} → {money2(draft.overrides.value ?? open.item.value)}</p></div>
                          <div><p className="lbl">Quantity</p><p className="mono mt-1">{open.item.quantity ?? "—"} → {draft.overrides.quantity ?? open.item.quantity ?? "—"}</p></div>
                          <div><p className="lbl">Status</p><p className="mt-1">{open.item.status ? STATUS_LABEL[open.item.status] : LEGACY_LABEL} → {STATUS_LABEL[draft.line.status]}</p></div>
                          <div><p className="lbl">Duty</p><p className="mono mt-1">{open.item.duty !== null ? money2(open.item.duty) : "Unpriced"} → {draft.line.duty !== undefined && draft.line.duty !== null ? money2(draft.line.duty) : "Unpriced"}</p></div>
                        </div>
                        <div className="flex flex-wrap gap-3">
                          <form action={confirmCorrectionAction}>
                            <input type="hidden" name="review_version" value={open.item.review_version} />
                            <input type="hidden" name="item_id" value={open.item.id} />
                            <input type="hidden" name="catalogue_id" value={cat.id} />
                            <input type="hidden" name="draft_id" value={sp.proposal} />
                            <input type="hidden" name="q" value={sp.q ?? ""} />
                            <input type="hidden" name="status" value={statusFilter} />
                            <input type="hidden" name="page" value={String(at)} />
                            <button type="submit" className="btn btn-primary">Confirm correction</button>
                          </form>
                          <Link href={correctionHref()} className="btn btn-secondary">Discard</Link>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-4">
                        {sp.proposal ? <p className="text-[13px] text-caution-ink">That correction has expired or could not be found. Recalculate again.</p> : null}
                        <form action={proposeCorrectionAction} className="flex flex-wrap items-end gap-3">
                          <input type="hidden" name="review_version" value={open.item.review_version} />
                          <input type="hidden" name="item_id" value={open.item.id} />
                          <input type="hidden" name="catalogue_id" value={cat.id} />
                          <input type="hidden" name="q" value={sp.q ?? ""} />
                          <input type="hidden" name="status" value={statusFilter} />
                          <input type="hidden" name="page" value={String(at)} />
                          <label className="min-w-[10rem] text-[13px]">
                            HTS code
                            <input name="hts" defaultValue={sp.pick ?? open.item.hts ?? ""} className="mono field-control mt-1 block w-full" placeholder="e.g. 6109.10.00.12" />
                          </label>
                          <label className="min-w-[10rem] text-[13px]">
                            Country of origin
                            <input name="country" defaultValue={open.item.country} list="correction-origins" autoComplete="off" className="field-control mt-1 block w-full" />
                            <datalist id="correction-origins">
                              {ORIGINS.map((o) => <option key={o} value={o} />)}
                            </datalist>
                          </label>
                          <label className="min-w-[8rem] text-[13px]">
                            Entered value (USD)
                            <input name="value" defaultValue={open.item.value} className="mono field-control mt-1 block w-full" />
                          </label>
                          <label className="min-w-[8rem] text-[13px]">
                            Quantity
                            <input name="quantity" defaultValue={open.item.quantity ?? ""} className="mono field-control mt-1 block w-full" />
                          </label>
                          <label className="min-w-[8rem] text-[13px]">
                            Unit
                            <input name="quantity_unit" defaultValue={open.item.quantity_unit ?? ""} className="field-control mt-1 block w-full" placeholder="e.g. kg" />
                          </label>
                          <button type="submit" className="btn btn-primary">Recalculate</button>
                        </form>

                        <div>
                          <Link href={sp.compare ? correctionHref() : correctionHref({ compare: "1" })} className="text-[13px] font-medium text-accent hover:underline">
                            {sp.compare ? "Hide candidates" : "Compare candidates"}
                          </Link>
                          {comparing ? (
                            candidateWait !== null ? (
                              <p className="mt-3 text-[13px] text-caution-ink">Too many lookups from this account. Try again in {candidateWait} seconds.</p>
                            ) : !candidateOutcome?.ok ? (
                              <p className="mt-3 text-[13px] text-caution-ink">Could not fetch candidates. Try again shortly.</p>
                            ) : candidateOutcome.data.candidates.length === 0 ? (
                              <p className="mt-3 text-[13px] text-muted">No candidates matched this description.</p>
                            ) : (
                              <div className="mt-3 space-y-3">
                                {candidateOutcome.data.candidates.map((c, i) => (
                                  <Card key={c.hts}>
                                    <div className="flex flex-wrap items-center gap-3">
                                      <span className="text-[13px] text-muted">#{i + 1}</span>
                                      <HtsLink code={c.hts} />
                                      <Badge tone={c.confidence === "low" ? "neutral" : "warn"}>{c.confidence} confidence</Badge>
                                      {c.general_rate ? <span className="tabular ml-auto text-[13px] text-muted">MFN {c.general_rate}</span> : null}
                                    </div>
                                    {c.description ? <p className="mt-3 text-[14px]">{c.description}</p> : null}
                                    {c.rulings?.length ? (
                                      <div className="mt-3 space-y-1">
                                        {c.rulings.map((r) => (
                                          <div key={r.ruling} className="text-[13px]">
                                            <a href={r.url ?? undefined} target="_blank" rel="noopener noreferrer" className="font-medium hover:underline text-accent">{r.ruling}<span aria-hidden="true" className="ml-0.5">↗</span><span className="sr-only"> (opens in a new tab)</span></a>{" "}
                                            {r.revoked ? <Badge tone="bad">revoked</Badge> : null}{" "}
                                            <span className="text-muted">{r.subject}</span>
                                          </div>
                                        ))}
                                      </div>
                                    ) : null}
                                    <div className="mt-4 border-t border-border pt-3">
                                      <Link href={correctionHref({ compare: "1", pick: c.hts })} className="btn btn-secondary">Use this code</Link>
                                    </div>
                                  </Card>
                                ))}
                              </div>
                            )
                          ) : null}
                        </div>
                      </div>
                    )}
                  </div>
                </details>

                <form action={setApprovalAction} className="flex flex-wrap items-end gap-3">
                  <input type="hidden" name="review_version" value={open.item.review_version} />
                  <input type="hidden" name="item_id" value={open.item.id} />
                  <input type="hidden" name="catalogue_id" value={cat.id} />
                  <input type="hidden" name="next_item_id" value={nextPendingId} />
                  <input type="hidden" name="q" value={sp.q ?? ""} />
                  <input type="hidden" name="status" value={statusFilter} />
                  <input type="hidden" name="page" value={String(nextPendingPage)} />
                  <label className="text-[13px]">
                    Decision
                    <select name="approval_status" defaultValue={open.review.approval_status} className="field-control mt-1 block w-full">
                      {APPROVAL_STATUSES.map((s) => <option key={s} value={s}>{APPROVAL_LABEL[s]}</option>)}
                    </select>
                  </label>
                  <label className="min-w-[16rem] flex-1 text-[13px]">
                    Note (optional)
                    <input name="note" maxLength={MAX_REVIEW_NOTE} className="field-control mt-1 block w-full" placeholder="Why, or what changed" />
                  </label>
                  <button type="submit" className="btn btn-primary">Record decision</button>
                  <button type="submit" name="advance" value="1" className="btn btn-secondary">Record decision and review next</button>
                </form>

                <form action={assignItemAction} className="flex flex-wrap items-end gap-3">
                  <input type="hidden" name="review_version" value={open.item.review_version} />
                  <input type="hidden" name="item_id" value={open.item.id} />
                  <input type="hidden" name="catalogue_id" value={cat.id} />
                  <label className="min-w-[16rem] flex-1 text-[13px]">
                    Assigned to
                    <input
                      name="assigned_to" maxLength={200} defaultValue={open.review.assigned_to ?? ""}
                      className="field-control mt-1 block w-full" placeholder="Name or email — leave blank to unassign"
                    />
                  </label>
                  <button type="submit" className="btn btn-secondary">Save assignment</button>
                </form>

                <div className="space-y-3 border-t border-rule pt-4">
                  <h3 className="text-[13px] font-medium uppercase tracking-wide text-muted">History</h3>
                  {history.length === 0 ? (
                    <p className="text-[13px] text-muted">Nothing recorded yet.</p>
                  ) : (
                    <ul className="space-y-2">
                      {history.map((event) => (
                        <li key={event.id} className="text-[13px]">
                          <span className="mono text-faint">{new Date(event.created_at).toLocaleString()}</span>{" "}
                          <span className="font-medium">{event.actor}</span>{" "}
                          {event.kind === "approval" && event.approval_status
                            ? <>marked it <span className={TONE[event.approval_status]}>{APPROVAL_LABEL[event.approval_status]}</span></>
                            : event.kind === "assignment"
                              ? <>{event.assigned_to ? <>assigned it to <strong>{event.assigned_to}</strong></> : "unassigned it"}</>
                              : event.kind === "correction"
                                ? "recorded a correction"
                                : "commented"}
                          {event.comment ? <span className="block pl-1 text-ink">“{event.comment}”</span> : null}
                        </li>
                      ))}
                    </ul>
                  )}
                  <form action={addCommentAction} className="flex flex-wrap items-end gap-3">
                    <input type="hidden" name="review_version" value={open.item.review_version} />
                    <input type="hidden" name="item_id" value={open.item.id} />
                    <input type="hidden" name="catalogue_id" value={cat.id} />
                    <label className="min-w-[16rem] flex-1 text-[13px]">
                      Add a comment
                      <textarea name="comment" maxLength={MAX_REVIEW_NOTE} rows={2} className="field-control mt-1 block w-full" required />
                    </label>
                    <button type="submit" className="btn btn-secondary">Comment</button>
                  </form>
                </div>
              </div>
            </Card>
          </div>
        ) : null}
      </div>
    </div>
  );
}
