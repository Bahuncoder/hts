"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { currentViewer } from "./auth";
import { proposeCorrection, confirmCorrection, type CorrectionOverrides } from "./correction";

/** Server actions for the review page's "Correct this line" flow. Kept apart
 *  from reviewActions.ts for the same reason review.ts and reprice.ts are
 *  kept apart — correction.ts owns its own schema and engine call, this is
 *  just the form boundary around it. Every action re-reads the signed-in
 *  viewer and re-checks ownership inside correction.ts; nothing here trusts
 *  a hidden field for who is asking.
 */

function path(catalogueId: string): string {
  return `/catalogues/${encodeURIComponent(catalogueId)}/review`;
}

function correctionUrl(catalogueId: string, opts: {
  item?: string; q?: string; status?: string; page?: string; proposal?: string; notice?: string; error?: string;
}): string {
  const qp = new URLSearchParams();
  if (opts.q) qp.set("q", opts.q);
  if (opts.status && opts.status !== "all") qp.set("status", opts.status);
  if (opts.page && opts.page !== "1") qp.set("page", opts.page);
  if (opts.item) qp.set("item", opts.item);
  if (opts.proposal) qp.set("proposal", opts.proposal);
  if (opts.notice) qp.set("notice", opts.notice);
  if (opts.error) qp.set("error", opts.error);
  const qs = qp.toString();
  const anchor = opts.item ? `#row-${encodeURIComponent(opts.item)}` : "";
  return `${path(catalogueId)}${qs ? `?${qs}` : ""}${anchor}`;
}

function version(form: FormData): number | null {
  const raw = form.get("review_version");
  const n = raw === null ? NaN : Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** Accepts "10000", "10,000" and "$2,499.50", same as the calculator's own
 *  parser. Blank means "no override", not zero. */
function parseAmount(raw: FormDataEntryValue | null): number | undefined {
  const s = String(raw ?? "").trim();
  if (!s) return undefined;
  const n = Number(s.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n > 0 && n <= 1e12 ? n : undefined;
}

function carry(form: FormData) {
  return {
    q: String(form.get("q") ?? ""),
    status: String(form.get("status") ?? ""),
    page: String(form.get("page") ?? ""),
  };
}

export async function proposeCorrectionAction(form: FormData): Promise<void> {
  const viewer = await currentViewer();
  if (!viewer) return;
  const itemId = String(form.get("item_id") ?? "");
  const catalogueId = String(form.get("catalogue_id") ?? "");
  if (!itemId || !catalogueId) return;
  const ctx = carry(form);
  const expected = version(form);
  if (expected === null) {
    return redirect(correctionUrl(catalogueId, { ...ctx, item: itemId, notice: "conflict" }));
  }

  const hts = String(form.get("hts") ?? "").trim();
  const country = String(form.get("country") ?? "").trim();
  const value = parseAmount(form.get("value"));
  const quantity = parseAmount(form.get("quantity"));
  const quantityUnit = String(form.get("quantity_unit") ?? "").trim();
  const overrides: CorrectionOverrides = {
    ...(hts ? { hts } : {}),
    ...(country ? { country } : {}),
    ...(value !== undefined ? { value } : {}),
    ...(quantity !== undefined ? { quantity } : {}),
    ...(quantityUnit ? { quantity_unit: quantityUnit } : {}),
  };

  const outcome = await proposeCorrection(viewer.account.id, catalogueId, itemId, overrides, expected);
  revalidatePath(path(catalogueId));
  if (!outcome.ok) {
    return redirect(correctionUrl(catalogueId, { ...ctx, item: itemId, error: outcome.error }));
  }
  redirect(correctionUrl(catalogueId, { ...ctx, item: itemId, proposal: outcome.draftId }));
}

export async function confirmCorrectionAction(form: FormData): Promise<void> {
  const viewer = await currentViewer();
  if (!viewer) return;
  const itemId = String(form.get("item_id") ?? "");
  const catalogueId = String(form.get("catalogue_id") ?? "");
  const draftId = String(form.get("draft_id") ?? "");
  if (!itemId || !catalogueId || !draftId) return;
  const ctx = carry(form);
  const expected = version(form);
  if (expected === null) {
    return redirect(correctionUrl(catalogueId, { ...ctx, item: itemId, notice: "conflict" }));
  }

  const outcome = await confirmCorrection(
    viewer.account.id, viewer.account.email, catalogueId, itemId, draftId, expected,
  );
  revalidatePath(path(catalogueId));
  revalidatePath(`/catalogues/${encodeURIComponent(catalogueId)}`);
  if (!outcome.ok) {
    return redirect(correctionUrl(catalogueId, { ...ctx, item: itemId, error: outcome.error }));
  }
  redirect(correctionUrl(catalogueId, { ...ctx, item: itemId, notice: "corrected" }));
}
