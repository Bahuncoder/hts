import { NextResponse } from "next/server";
import { API_BASE } from "@/lib/api";
import { currentViewer } from "@/lib/auth";
import { acquireLease, chargeAudit } from "@/lib/budget";
import { LIMITS, windowLabel } from "@/lib/plans";
import { clientId } from "@/lib/throttle";
import { signAudit, signedBodyFromEngine, signingSecret, type EngineRequest } from "@/lib/auditProof";
import { readCapped } from "@/lib/requestBody";
import { sameOrigin } from "@/lib/requestOrigin";

/** Server-side proxy for the catalogue audit.
 *
 *  The browser posts here rather than to the engine directly. That keeps the
 *  engine off the public internet, removes the cross-origin exchange, and
 *  keeps the API key server-side — a key shipped to the browser under
 *  NEXT_PUBLIC_ is a published key.
 *
 *  It is also where the per-audit ceiling is enforced, because the ceiling is a
 *  real cost control: classification costs ~175 ms of CPU per item. The
 *  engine exempts this proxy's key from its own rate limit, so the per-caller
 *  budgets and the one-audit-at-a-time lease live here (lib/budget.ts).
 */
export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_BODY = 2_000_000;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const tooLarge = () => NextResponse.json(
  { detail: "Catalogue too large. Split it across several runs." },
  { status: 413 },
);

/** Adds the proof that lets this result be saved. A saved catalogue must hold
 *  figures our engine produced, so the save action accepts nothing that does
 *  not carry this signature (lib/auditProof.ts).
 *
 *  Without a configured secret, production returns the audit unsigned rather
 *  than signing with a guessable constant: the customer still gets their
 *  numbers, and saving reports that it is unavailable. */
function withProof(body: string, request: EngineRequest): string {
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return body; }

  const secret = signingSecret();
  if (!secret) {
    console.error(
      "audit: HTSDESK_SIGNING_SECRET (or HTSDESK_EMAIL_SECRET / HTSDESK_ADMIN_TOKEN) is not " +
      "set; returning the audit without a proof, so it cannot be saved",
    );
    return body;
  }
  const signed = signedBodyFromEngine(parsed, request);
  if (!signed) {
    console.error("audit: the engine response is not in the expected shape; returning it unsigned");
    return body;
  }
  const proof = signAudit(signed, secret);
  // entries/by_vessel are not part of the engine's own summary — added here
  // so the browser can echo them back at save time, the same way it already
  // does for dataset_revision, assumptions and mpf, which ARE.
  const engineResponse = parsed as { summary?: Record<string, unknown> };
  if (engineResponse.summary) {
    engineResponse.summary.entries = signed.entries;
    engineResponse.summary.by_vessel = signed.by_vessel;
  }
  return JSON.stringify({ ...engineResponse, proof, signed_at: signed.at });
}

const bad = (detail: string) => NextResponse.json({ detail }, { status: 400 });

function throttled(retryAfter: number, detail: string) {
  return NextResponse.json(
    { detail },
    { status: 429, headers: { "retry-after": String(retryAfter) } },
  );
}

function waitText(seconds: number): string {
  if (seconds < 90) return `${seconds} seconds`;
  if (seconds < 90 * 60) return `${Math.ceil(seconds / 60)} minutes`;
  return `${Math.ceil(seconds / 3600)} hours`;
}

export async function POST(request: Request) {
  // Cookie-authenticated: a browser sends Origin on a cross-origin POST, so a
  // request from elsewhere is refused before its body is read (audit S03).
  if (!sameOrigin(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY) return tooLarge();

  const raw = await readCapped(request, MAX_BODY);
  if (raw === null) return tooLarge();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return bad("Malformed request body.");
  }
  if (!isObject(parsed) || !Array.isArray(parsed.items) || !parsed.items.every(isObject)) {
    return bad("Send a JSON object with an items array of products.");
  }
  if (!parsed.items.length) return bad("Add at least one product to audit.");

  const viewer = await currentViewer();
  // A signed-in caller's real limits (plan-aware, once billing resolves it),
  // not a flat "every account is the same" ceiling.
  const limits = viewer ? viewer.limits : LIMITS.anonymous;
  const count = parsed.items.length;

  if (count > limits.productsPerAudit) {
    return NextResponse.json(
      {
        detail: viewer
          ? `${count} products exceeds the ${limits.productsPerAudit.toLocaleString()} allowed in one audit. Split the catalogue across several runs.`
          : `${count} products exceeds the ${limits.productsPerAudit} allowed without an account. Create a free account for a larger allowance, or split the catalogue.`,
      },
      { status: 413 },
    );
  }

  const subject = viewer ? `account:${viewer.account.id}` : `client:${await clientId()}`;
  // Anonymous callers are pointed at the free account; a signed-in one has
  // nothing larger to move to, so is told when the allowance frees up.
  const hint = viewer ? " The allowance resets on a rolling basis."
    : " Create a free account for a larger allowance.";

  const release = await acquireLease(subject);
  if (!release) {
    return throttled(5, "An audit is already running for you. Wait for it to finish, then submit the next one.");
  }

  const budget = { requests: limits.auditRequests, items: limits.itemsPerDay };
  try {
    const charge = await chargeAudit(subject, budget, count);
    if (!charge.ok) {
      const detail = charge.tooLarge
        ? `This run is larger than the ${budget.items.max.toLocaleString()}-product daily allowance.${hint}`
        : charge.over === "requests"
          ? `You have reached the limit of ${budget.requests.max} audits per ${windowLabel(budget.requests.windowMs)}. Try again in ${waitText(charge.retryAfter)}.${hint}`
          : `This run would exceed your daily allowance of ${budget.items.max.toLocaleString()} products. More becomes available in ${waitText(charge.retryAfter)}.${hint}`;
      return throttled(charge.retryAfter, detail);
    }

    const headers: Record<string, string> = { "content-type": "application/json" };
    const key = process.env.HTSDESK_API_KEY;
    if (key) headers["x-api-key"] = key;

    try {
      const res = await fetch(`${API_BASE}/api/audit`, {
        method: "POST",
        headers,
        body: JSON.stringify(parsed),
        cache: "no-store",
        signal: AbortSignal.timeout(55_000),
      });
      const body = await res.text();
      // The engine did no work for a failure on its side; do not bill for it.
      if (res.status >= 500) await charge.refund();
      return new NextResponse(res.status === 200 ? withProof(body, parsed) : body, {
        status: res.status,
        headers: { "content-type": "application/json" },
      });
    } catch (error) {
      // A timeout does not establish that the engine stopped doing work.
      if (!(error instanceof Error && error.name === "TimeoutError")) await charge.refund();
      return NextResponse.json(
        { detail: "The duty engine is unavailable. Try again shortly." },
        { status: 502 },
      );
    }
  } finally {
    await release();
  }
}
