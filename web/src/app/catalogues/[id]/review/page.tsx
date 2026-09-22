import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { currentViewer } from "@/lib/auth";
import { getCatalogue } from "@/lib/catalogues";
import { LEGACY_LABEL, STATUS_LABEL } from "@/lib/auditModel";
import {
  APPROVAL_LABEL, APPROVAL_STATUSES, approvalCounts, catalogueReviewState,
  itemHistory, type ApprovalStatus,
} from "@/lib/review";
import { addCommentAction, assignItemAction, setApprovalAction } from "@/lib/reviewActions";
import { Card } from "@/components/ui";
import { money2 } from "@/lib/api";
import { MAX_REVIEW_NOTE } from "@/lib/reviewModel";
import EvidenceSnapshot from "@/components/EvidenceSnapshot";

export const dynamic = "force-dynamic";
export const metadata = { title: "Review" };

const TONE: Record<ApprovalStatus, string> = {
  pending: "text-muted",
  approved: "text-accent",
  changes_requested: "text-caution-ink",
  rejected: "text-danger",
};

export default async function Review({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ item?: string; notice?: string }>;
}) {
  const viewer = await currentViewer();
  if (!viewer) redirect("/login");
  const { id } = await params;
  const cat = await getCatalogue(viewer.account.id, id);
  if (!cat) notFound();
  const state = await catalogueReviewState(viewer.account.id, id);
  const rows = cat.items.map((item) => ({
    item, review: state.get(item.id) ?? { id: item.id, approval_status: "pending" as ApprovalStatus, assigned_to: null },
  }));
  const counts = approvalCounts(rows.map((r) => r.review));

  const openId = (await searchParams).item;
  const open = openId ? rows.find((r) => r.item.id === openId) : undefined;
  const history = open ? await itemHistory(viewer.account.id, open.item.id) : [];

  return (
    <div className="space-y-6">
      {(await searchParams).notice === "conflict" && <p role="alert" className="text-caution-ink">The review could not be saved. This view has been refreshed: check for a newer decision. Unclassified or incomplete lines cannot be approved.</p>}
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

      <div className="flex flex-wrap gap-3 text-[13px]">
        {APPROVAL_STATUSES.map((s) => (
          <span key={s} className={`rounded-full border border-border px-3 py-1 ${TONE[s]}`}>
            {APPROVAL_LABEL[s]}: {counts[s]}
          </span>
        ))}
      </div>

      <Card>
        <div className="scroll-x">
          <table className="data-table w-full min-w-[720px] text-[14px]">
            <caption className="sr-only">Products in {cat.name} with their review status</caption>
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
              {rows.map(({ item, review }) => (
                <tr key={item.id} className={item.id === openId ? "bg-sunk" : undefined}>
                  <td className="mono">{item.row_number ?? "—"}</td>
                  <td>{item.description || "—"}</td>
                  <td>{item.country}</td>
                  <td className="mono">{item.hts ?? "Unclassified"}</td>
                  <td>{item.status ? STATUS_LABEL[item.status] : LEGACY_LABEL}</td>
                  <td className={TONE[review.approval_status]}>{APPROVAL_LABEL[review.approval_status]}</td>
                  <td>{review.assigned_to || "—"}</td>
                  <td>
                    <Link href={`/catalogues/${cat.id}/review?item=${item.id}`} className="text-accent hover:underline">
                      {item.id === openId ? "Open" : "Review"}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {open ? (
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
            <form action={setApprovalAction} className="flex flex-wrap items-end gap-3">
              <input type="hidden" name="review_version" value={open.item.review_version} />
              <input type="hidden" name="item_id" value={open.item.id} />
              <input type="hidden" name="catalogue_id" value={cat.id} />
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
      ) : null}
    </div>
  );
}
