import { NextResponse } from "next/server";
import { currentViewer } from "@/lib/auth";
import { readCapped } from "@/lib/requestBody";
import {
  runRefundCheck, RefundCheckLimitError, RefundCheckBudgetError, type ValidRefundCheckRow,
} from "@/lib/refundCheck";
import { windowLabel } from "@/lib/plans";
import { audit } from "@/lib/audit";

/** Entry Refund Check's server-side endpoint. The browser parses and
 *  validates the pasted/uploaded CSV client-side (lib/refundCheckCsv.ts, for
 *  immediate feedback); this route does not trust that and re-validates the
 *  submitted JSON shape itself before anything reaches the engine or the
 *  database, same discipline as the audit route.
 *
 *  A row that fails validation here is excluded from the batch, never
 *  silently -- the response names every excluded row and why. */
export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_BODY = 2_000_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function validate(item: unknown, row: number): { ok: true; item: ValidRefundCheckRow } | { ok: false; row: number; reason: string } {
  if (!isObject(item)) return { ok: false, row, reason: "not a valid entry" };
  const description = typeof item.description === "string" ? item.description.trim() : "";
  const country = typeof item.country === "string" ? item.country.trim() : "";
  const sku = typeof item.sku === "string" ? item.sku : "";
  const entryHts = item.entryHts === null || item.entryHts === undefined ? null
    : typeof item.entryHts === "string" ? item.entryHts : undefined;
  const value = typeof item.value === "number" ? item.value : NaN;
  const entryDate = typeof item.entryDate === "string" ? item.entryDate : "";
  const dutyPaid = typeof item.dutyPaid === "number" ? item.dutyPaid : NaN;
  const liquidationDate = item.liquidationDate === null || item.liquidationDate === undefined ? null
    : typeof item.liquidationDate === "string" ? item.liquidationDate : undefined;

  if (!description && !entryHts) return { ok: false, row, reason: "no description" };
  if (!country) return { ok: false, row, reason: "no country" };
  if (!Number.isFinite(value) || value <= 0) return { ok: false, row, reason: "entered value must be a positive number" };
  if (!entryDate || !ISO_DATE.test(entryDate)) return { ok: false, row, reason: "entry date must be given as yyyy-mm-dd" };
  if (!Number.isFinite(dutyPaid) || dutyPaid < 0) return { ok: false, row, reason: "duty paid must be a non-negative number" };
  if (liquidationDate === undefined) return { ok: false, row, reason: "liquidation date must be given as yyyy-mm-dd, or omitted" };
  if (liquidationDate && !ISO_DATE.test(liquidationDate)) return { ok: false, row, reason: "liquidation date must be given as yyyy-mm-dd" };
  if (entryHts === undefined) return { ok: false, row, reason: "hts must be a string, or omitted" };

  return {
    ok: true,
    item: {
      row, sku, description, country, value, rawValue: "",
      entryHts: entryHts || null, entryDate, rawEntryDate: "",
      dutyPaid, rawDutyPaid: "", liquidationDate, rawLiquidationDate: "",
      problems: [],
    },
  };
}

function waitText(seconds: number): string {
  if (seconds < 90) return `${seconds} seconds`;
  if (seconds < 90 * 60) return `${Math.ceil(seconds / 60)} minutes`;
  return `${Math.ceil(seconds / 3600)} hours`;
}

export async function POST(request: Request) {
  const viewer = await currentViewer();
  if (!viewer) return NextResponse.json({ detail: "Sign in first." }, { status: 401 });
  const { limits } = viewer;
  if (!limits.refundCheck.enabled) {
    return NextResponse.json(
      { detail: "Entry Refund Check is not included on your plan. See /pricing to upgrade." },
      { status: 403 },
    );
  }

  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY) {
    return NextResponse.json({ detail: "Request too large. Split it across several runs." }, { status: 413 });
  }
  const raw = await readCapped(request, MAX_BODY);
  if (raw === null) return NextResponse.json({ detail: "Request too large. Split it across several runs." }, { status: 413 });

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return NextResponse.json({ detail: "Malformed request body." }, { status: 400 });
  }
  if (!isObject(parsed) || typeof parsed.name !== "string" || !Array.isArray(parsed.items)) {
    return NextResponse.json({ detail: "Send a JSON object with a name and an items array." }, { status: 400 });
  }
  const name = parsed.name.trim().slice(0, 200) || "Untitled refund check";
  const checkClassification = parsed.checkClassification === true;
  if (!parsed.items.length) return NextResponse.json({ detail: "Add at least one entry." }, { status: 400 });
  if (parsed.items.length > limits.productsPerAudit) {
    return NextResponse.json(
      { detail: `${parsed.items.length} entries exceeds the ${limits.productsPerAudit.toLocaleString()} allowed in one run. Split it across several runs.` },
      { status: 413 },
    );
  }

  const valid: ValidRefundCheckRow[] = [];
  const rejected: { row: number; reason: string }[] = [];
  parsed.items.forEach((item, i) => {
    const result = validate(item, i + 1);
    if (result.ok) valid.push(result.item);
    else rejected.push({ row: result.row, reason: result.reason });
  });
  if (!valid.length) {
    return NextResponse.json({ detail: "No entry could be read.", rejected }, { status: 400 });
  }

  const budget = { requests: limits.refundCheck.requests, items: limits.refundCheck.itemsPerDay };
  try {
    const result = await runRefundCheck(viewer.account.id, name, valid, budget, limits.refundCheck.maxChecks, checkClassification);
    await audit("refund_check_run", { accountId: viewer.account.id, email: viewer.account.email,
      detail: `${valid.length} entries` });
    return NextResponse.json({ id: result.id, items: result.items, rejected });
  } catch (err) {
    if (err instanceof RefundCheckLimitError) {
      return NextResponse.json({ detail: err.message }, { status: 413 });
    }
    if (err instanceof RefundCheckBudgetError) {
      const detail = err.tooLarge
        ? `This run is larger than the ${budget.items.max.toLocaleString()}-entry daily allowance.`
        : err.over === "requests"
          ? `You have reached the limit of ${budget.requests.max} runs per ${windowLabel(budget.requests.windowMs)}. Try again in ${waitText(err.retryAfter)}.`
          : `This run would exceed your daily allowance of ${budget.items.max.toLocaleString()} entries. Try again in ${waitText(err.retryAfter)}.`;
      return NextResponse.json({ detail }, { status: 429, headers: { "retry-after": String(err.retryAfter) } });
    }
    console.error("refund-check failed", err);
    return NextResponse.json(
      { detail: "The duty engine could not process this request. Try again shortly." }, { status: 502 },
    );
  }
}
