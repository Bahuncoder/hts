import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { googleAuthUrl, googleEnabled } from "@/lib/googleAuth";
import { safeNext } from "@/lib/next";

export const runtime = "nodejs";

export const STATE_COOKIE = "htsdesk_oauth_state";
export const REDIRECT_PATH = "/api/auth/google/callback";

/** Starts the flow: redirects to Google, having first put a random value in
 *  both the outgoing `state` and an HttpOnly cookie only this server can
 *  read back. The callback accepts a `code` only when the two still match,
 *  which a page that merely links here (not one running as this origin)
 *  cannot arrange. */
export async function GET(request: Request) {
  if (!googleEnabled()) return NextResponse.json({ error: "Not available." }, { status: 404 });

  const url = new URL(request.url);
  const next = safeNext(url.searchParams.get("next")) ?? "";
  const random = crypto.randomBytes(24).toString("base64url");
  const state = `${random}:${next}`;

  (await cookies()).set(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/api/auth/google",
    maxAge: 600,
  });

  const site = process.env.SITE_URL ?? url.origin;
  const redirectUri = new URL(REDIRECT_PATH, site).toString();
  return NextResponse.redirect(googleAuthUrl(state, redirectUri));
}
