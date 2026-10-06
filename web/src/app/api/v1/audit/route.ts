import { NextResponse } from "next/server";
import { API_BASE, engineHeaders } from "@/lib/api";
import { verifyApiKey } from "@/lib/apiKeys";
import { acquireLease, chargeApi } from "@/lib/budget";
import { planFor } from "@/lib/store";
import { readCapped } from "@/lib/requestBody";

/** The public, versioned B2B API: a customer's own backend calls this with a
 *  bearer key instead of a browser calling app/api/audit with a session
 *  cookie. Same engine underneath, same server-side HTSDESK_API_KEY -- the
 *  engine never sees an external customer's identity, only this proxy's own
 *  credential, exactly as it does for the browser-facing route.
 *
 *  This is a versioned contract customers write code against, so unlike the
 *  internal route it normalizes every failure into a stable {error, detail}
 *  shape and never passes through the engine's own raw error text.
 *
 *  Deliberately not CORS-enabled: the key is a server-side bearer credential
 *  for a customer's own backend, never meant to reach their browser JS (the
 *  same reason HTSDESK_API_KEY itself is never shipped to a browser). Without
 *  an OPTIONS export, Next replies to a preflight with just an Allow header,
 *  so a cross-origin browser fetch fails closed by default.
 */
export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_BODY = 2_000_000;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function fail(status: number, error: string, detail: string, headers?: Record<string, string>) {
  return NextResponse.json({ error, detail }, { status, headers });
}

function waitText(seconds: number): string {
  if (seconds < 90) return `${seconds} seconds`;
  if (seconds < 90 * 60) return `${Math.ceil(seconds / 60)} minutes`;
  return `${Math.ceil(seconds / 3600)} hours`;
}

export async function POST(request: Request) {
  const auth = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(auth);
  if (!match) {
    return fail(401, "unauthorized", "Send your API key as 'Authorization: Bearer <key>'.");
  }

  const key = await verifyApiKey(match[1]);
  if (!key) {
    return fail(401, "unauthorized", "That API key is invalid or has been revoked.");
  }

  const { limits } = await planFor(key.account_id);
  if (!limits.api.enabled) {
    return fail(403, "forbidden", "API access is not included on your plan. See /pricing to upgrade.");
  }

  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY) {
    return fail(413, "too_large", "Request body too large. Split the catalogue across several calls.");
  }
  const raw = await readCapped(request, MAX_BODY);
  if (raw === null) {
    return fail(413, "too_large", "Request body too large. Split the catalogue across several calls.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail(400, "bad_request", "Malformed request body.");
  }
  if (!isObject(parsed) || !Array.isArray(parsed.items) || !parsed.items.every(isObject)) {
    return fail(400, "bad_request", "Send a JSON object with an items array of products.");
  }
  if (!parsed.items.length) {
    return fail(400, "bad_request", "Add at least one product to audit.");
  }

  const count = parsed.items.length;
  if (count > limits.productsPerAudit) {
    return fail(413, "too_large",
      `${count} products exceeds the ${limits.productsPerAudit.toLocaleString()} allowed in one request. Split the catalogue across several calls.`);
  }

  const subject = `account:${key.account_id}`;
  const release = await acquireLease(`api:${key.account_id}`);
  if (!release) {
    return fail(429, "rate_limited", "A request is already running for this account. Wait for it to finish, then submit the next one.",
      { "retry-after": "5" });
  }

  try {
    const budget = { requests: limits.api.requests, items: limits.api.itemsPerDay };
    const charge = await chargeApi(subject, budget, count);
    if (!charge.ok) {
      const detail = charge.tooLarge
        ? `This request is larger than the ${budget.items.max.toLocaleString()}-product daily allowance.`
        : charge.over === "requests"
          ? `Rate limit exceeded: ${budget.requests.max} requests per minute. Try again in ${waitText(charge.retryAfter)}.`
          : `Daily allowance of ${budget.items.max.toLocaleString()} products exceeded. Try again in ${waitText(charge.retryAfter)}.`;
      return fail(429, "rate_limited", detail, { "retry-after": String(charge.retryAfter) });
    }

    try {
      const res = await fetch(`${API_BASE}/api/audit`, {
        method: "POST",
        headers: { "content-type": "application/json", ...engineHeaders() },
        body: JSON.stringify(parsed),
        cache: "no-store",
        signal: AbortSignal.timeout(55_000),
      });
      if (res.status !== 200) {
        await charge.refund();
        return fail(502, "engine_unavailable", "The duty engine could not process this request. Try again shortly.");
      }
      const body = await res.text();
      return new NextResponse(body, { status: 200, headers: { "content-type": "application/json" } });
    } catch (error) {
      // A timeout does not establish that the engine stopped doing work.
      if (!(error instanceof Error && error.name === "TimeoutError")) await charge.refund();
      return fail(502, "engine_unavailable", "The duty engine could not process this request. Try again shortly.");
    }
  } finally {
    await release();
  }
}
