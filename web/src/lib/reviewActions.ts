"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { currentViewer } from "./auth";
import { addComment, assignItem, isApprovalStatus, setApproval } from "./review";

/** Server actions for human review of a saved catalogue line: approve /
 *  request changes / reject, assign, and comment. Kept apart from
 *  actions.ts on purpose — the same reason review.ts is apart from
 *  catalogues.ts — so this feature is one self-contained unit.
 *
 *  Every action re-reads the signed-in viewer and re-checks ownership inside
 *  lib/review.ts; nothing here trusts a hidden field for who is asking.
 */

function path(catalogueId: string): string {
  return `/catalogues/${encodeURIComponent(catalogueId)}/review`;
}

/** Rebuilds a review-page URL from the same q/status/page/item fields the
 *  page itself puts in hidden inputs — used for the "and review next"
 *  redirect, which has no request context to read them from otherwise. */
function reviewUrl(catalogueId: string, opts: { item?: string; q?: string; status?: string; page?: string; notice?: string }): string {
  const qp = new URLSearchParams();
  if (opts.q) qp.set("q", opts.q);
  if (opts.status && opts.status !== "all") qp.set("status", opts.status);
  if (opts.page && opts.page !== "1") qp.set("page", opts.page);
  if (opts.item) qp.set("item", opts.item);
  if (opts.notice) qp.set("notice", opts.notice);
  const qs = qp.toString();
  const anchor = opts.item ? `#row-${encodeURIComponent(opts.item)}` : "";
  return `${path(catalogueId)}${qs ? `?${qs}` : ""}${anchor}`;
}

function version(form: FormData): number | null {
  const raw = form.get("review_version");
  const n = raw === null ? NaN : Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function finish(ok: boolean, catalogueId: string, itemId: string, onSuccess?: string) {
  revalidatePath(path(catalogueId));
  revalidatePath(`/catalogues/${encodeURIComponent(catalogueId)}`);
  if (!ok) redirect(`${path(catalogueId)}?item=${encodeURIComponent(itemId)}&notice=conflict`);
  if (onSuccess) redirect(onSuccess);
}

export async function setApprovalAction(form: FormData): Promise<void> {
  const viewer = await currentViewer();
  if (!viewer) return;
  const itemId = String(form.get("item_id") ?? "");
  const catalogueId = String(form.get("catalogue_id") ?? "");
  const status = String(form.get("approval_status") ?? "");
  const note = String(form.get("note") ?? "");
  if (!itemId || !catalogueId || !isApprovalStatus(status)) return;
  const expected = version(form);
  if (expected === null) return finish(false, catalogueId, itemId);
  const ok = await setApproval(viewer.account.id, viewer.account.email, itemId, status, note, expected);
  if (ok && form.get("advance")) {
    const nextItemId = String(form.get("next_item_id") ?? "");
    const q = String(form.get("q") ?? "");
    const statusFilter = String(form.get("status") ?? "");
    const page = String(form.get("page") ?? "");
    const target = nextItemId
      ? reviewUrl(catalogueId, { item: nextItemId, q, status: statusFilter, page })
      : reviewUrl(catalogueId, { q, status: statusFilter, notice: "queue_complete" });
    return finish(ok, catalogueId, itemId, target);
  }
  finish(ok, catalogueId, itemId);
}

export async function assignItemAction(form: FormData): Promise<void> {
  const viewer = await currentViewer();
  if (!viewer) return;
  const itemId = String(form.get("item_id") ?? "");
  const catalogueId = String(form.get("catalogue_id") ?? "");
  const assignee = String(form.get("assigned_to") ?? "");
  if (!itemId || !catalogueId) return;
  const expected = version(form);
  if (expected === null) return finish(false, catalogueId, itemId);
  const ok = await assignItem(viewer.account.id, viewer.account.email, itemId, assignee, expected);
  finish(ok, catalogueId, itemId);
}

export async function addCommentAction(form: FormData): Promise<void> {
  const viewer = await currentViewer();
  if (!viewer) return;
  const itemId = String(form.get("item_id") ?? "");
  const catalogueId = String(form.get("catalogue_id") ?? "");
  const text = String(form.get("comment") ?? "");
  if (!itemId || !catalogueId || !text.trim()) return;
  const expected = version(form);
  if (expected === null) return finish(false, catalogueId, itemId);
  const ok = await addComment(viewer.account.id, viewer.account.email, itemId, text, expected);
  finish(ok, catalogueId, itemId);
}
