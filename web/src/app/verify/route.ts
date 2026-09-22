import { NextResponse } from "next/server";
import { completeVerifyAction } from "@/lib/actions";
import { sameOrigin } from "@/lib/requestOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Shows a confirmation page. Verification is deliberately POST-only so a
 * link preview, image, or cross-site navigation cannot log a browser in. */
export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return NextResponse.redirect(new URL("/signup?verify=expired", request.url), { status: 303 });
  return new NextResponse(`<!doctype html><meta charset="utf-8"><title>Confirm email</title><main><h1>Confirm your email</h1><p>Verify your address, then sign in with your password.</p><form method="post"><input type="hidden" name="token" value="${token}"><button type="submit">Verify email</button></form></main>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
  }
  const body = await request.formData();
  const token = String(body.get("token") ?? "");
  const site = process.env.SITE_URL ?? new URL(request.url).origin;
  const result = await completeVerifyAction(token);
  if (result.ok) return NextResponse.redirect(new URL("/login", site), { status: 303 });
  return NextResponse.redirect(new URL("/signup?verify=expired", site), { status: 303 });
}
