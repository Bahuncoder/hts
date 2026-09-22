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

function version(form: FormData): number | null {
  const raw = form.get("review_version");
  const n = raw === null ? NaN : Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function finish(ok: boolean, catalogueId: string, itemId: string) {
  revalidatePath(path(catalogueId));
  revalidatePath(`/catalogues/${encodeURIComponent(catalogueId)}`);
  if (!ok) redirect(`${path(catalogueId)}?item=${encodeURIComponent(itemId)}&notice=conflict`);
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
