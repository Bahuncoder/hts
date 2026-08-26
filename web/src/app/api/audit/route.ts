import { NextResponse } from "next/server";
import { API_BASE } from "@/lib/api";
import { currentViewer } from "@/lib/auth";
import { PLANS } from "@/lib/plans";

/** Server-side proxy for the catalogue audit.
 *
 *  The browser posts here rather than to the engine directly. That keeps the
 *  engine off the public internet, removes the cross-origin exchange, and
 *  keeps the API key server-side — a key shipped to the browser under
 *  NEXT_PUBLIC_ is a published key.
 *
 *  It is also where the plan ceiling is enforced, because the ceiling is a
 *  real cost control: classification costs ~175 ms of CPU per item.
 */
export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_BODY = 2_000_000;

export async function POST(request: Request) {
  const raw = await request.text();
  if (raw.length > MAX_BODY) {
    return NextResponse.json(
      { detail: "Catalogue too large. Split it across several runs." },
      { status: 413 },
    );
  }

  let parsed: { items?: unknown[] };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return NextResponse.json({ detail: "Malformed request body." }, { status: 400 });
  }

  const viewer = await currentViewer();
  const plan = viewer?.plan ?? PLANS.free;
  const count = Array.isArray(parsed.items) ? parsed.items.length : 0;

  if (count > plan.skus) {
    return NextResponse.json(
      {
        detail: viewer
          ? `${count} products exceeds the ${plan.skus.toLocaleString()} allowed on ${plan.name}. Upgrade, or split the catalogue.`
          : `${count} products exceeds the ${plan.skus} allowed without an account. Create a free account, or split the catalogue.`,
        upgrade: viewer ? "/pricing" : "/signup",
      },
      { status: 413 },
    );
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
    return new NextResponse(body, {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  } catch {
    return NextResponse.json(
      { detail: "The duty engine is unavailable. Try again shortly." },
      { status: 502 },
    );
  }
}
