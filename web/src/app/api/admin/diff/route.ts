import { NextResponse } from "next/server";
import { isAdmin, refuse } from "@/lib/adminAuth";
import { runDiff, diffStatus, sendAlertDigests } from "@/lib/diff";
import { purgeExpired } from "@/lib/tokens";
import { reportFindings, scanAuditLog } from "@/lib/watch";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  if (!isAdmin(request)) return refuse();
  const url = new URL(request.url);
  const since = url.searchParams.get("since") ?? undefined;
  const limit = Number(url.searchParams.get("limit") ?? 500);
  const diff = runDiff({ since, limit: Math.min(Math.max(limit, 1), 2000) });
  // Delivery is part of the same run: an alert nobody is told about is not an
  // alert. `send=0` runs the match alone, for backfills.
  const deliver = url.searchParams.get("send") !== "0";
  const delivery = deliver ? await sendAlertDigests() : null;
  // Housekeeping on the same schedule, rather than another timer to forget.
  const tokensPurged = purgeExpired();
  // A log nobody reads is filing, not security.
  const security = await reportFindings(scanAuditLog());
  return NextResponse.json({ ...diff, delivery, tokensPurged, security });
}

export async function GET(request: Request) {
  if (!isAdmin(request)) return refuse();
  return NextResponse.json(diffStatus() ?? { last_seen_date: null, last_run_at: null });
}
