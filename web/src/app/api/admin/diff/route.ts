import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { runDiff, diffStatus, sendAlertDigests } from "@/lib/diff";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Runs the change diff. Called on a schedule, not by a person.
 *
 *  Guarded by a shared token rather than a session: the caller is a cron job.
 *  Without HTSDESK_ADMIN_TOKEN set the route refuses outright, so a
 *  deployment that forgets to configure it is closed rather than open.
 */
function authorised(request: Request): boolean {
  const expected = process.env.HTSDESK_ADMIN_TOKEN;
  if (!expected) return false;
  const given = request.headers.get("x-admin-token") ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  if (!authorised(request)) {
    return NextResponse.json({ error: "not authorised" }, { status: 401 });
  }
  const url = new URL(request.url);
  const since = url.searchParams.get("since") ?? undefined;
  const limit = Number(url.searchParams.get("limit") ?? 500);
  const diff = runDiff({ since, limit: Math.min(Math.max(limit, 1), 2000) });
  // Delivery is part of the same run: an alert nobody is told about is not an
  // alert. `send=0` runs the match alone, for backfills.
  const deliver = url.searchParams.get("send") !== "0";
  const delivery = deliver ? await sendAlertDigests() : null;
  return NextResponse.json({ ...diff, delivery });
}

export async function GET(request: Request) {
  if (!authorised(request)) {
    return NextResponse.json({ error: "not authorised" }, { status: 401 });
  }
  return NextResponse.json(diffStatus() ?? { last_seen_date: null, last_run_at: null });
}
