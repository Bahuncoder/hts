import crypto from "node:crypto";
import { NextResponse } from "next/server";

/** Shared-token gate for the scheduled-job endpoints.
 *
 *  The caller is a cron job, not a person, so this is a token rather than a
 *  session. It refuses outright when the token is unset, so a deployment that
 *  forgets to configure one fails closed rather than open.
 *
 *  Lives here because two routes had their own copy; a second implementation
 *  of an auth check is a second place for it to drift.
 */
export function isAdmin(request: Request): boolean {
  const expected = process.env.HTSDESK_ADMIN_TOKEN;
  if (!expected) return false;
  const given = request.headers.get("x-admin-token") ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  // Length must match before timingSafeEqual, which throws on a mismatch.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function refuse(): NextResponse {
  return NextResponse.json({ error: "not authorised" }, { status: 401 });
}
