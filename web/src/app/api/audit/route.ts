import { NextResponse } from "next/server";
import { API_BASE } from "@/lib/api";

/** Server-side proxy for the catalogue audit.
 *
 *  The browser posts here rather than to the engine directly. That keeps the
 *  engine off the public internet, removes the cross-origin exchange, and —
 *  most importantly — keeps the API key server-side. A key shipped to the
 *  browser under NEXT_PUBLIC_ is a published key.
 */
export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_BODY = 2_000_000; // bytes; the engine caps item count separately

export async function POST(request: Request) {
  const raw = await request.text();
  if (raw.length > MAX_BODY) {
    return NextResponse.json(
      { detail: "Catalogue too large. Split it across several runs." },
      { status: 413 },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return NextResponse.json({ detail: "Malformed request body." }, { status: 400 });
  }

  const headers: Record<string, string> = { "content-type": "application/json" };
  const key = process.env.TARIFFWISE_API_KEY;
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
