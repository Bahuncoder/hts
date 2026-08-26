import { NextResponse } from "next/server";
import { completeVerifyAction } from "@/lib/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Confirms an email and signs the new account in.
 *
 *  A Route Handler, not a page: verification sets a session cookie, and Next
 *  refuses cookie writes during a Server Component render. As a page this
 *  returned 500 *after* creating the account — the work succeeded and the
 *  customer saw a crash.
 */
export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const site = process.env.SITE_URL ?? new URL(request.url).origin;

  const result = await completeVerifyAction(token);
  if (result.ok) {
    return NextResponse.redirect(new URL("/account", site), { status: 303 });
  }
  const back = new URL("/signup", site);
  back.searchParams.set("verify", "expired");
  return NextResponse.redirect(back, { status: 303 });
}
