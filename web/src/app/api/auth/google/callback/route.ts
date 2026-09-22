import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { googleEnabled, googleProfile } from "@/lib/googleAuth";
import { accountByEmail } from "@/lib/store";
import { markEmailVerified, signUp, startSession } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { safeNext } from "@/lib/next";
import { STATE_COOKIE, REDIRECT_PATH } from "../route";

export const runtime = "nodejs";

function fail(site: string, reason: string) {
  const url = new URL("/login", site);
  url.searchParams.set("error", reason);
  return NextResponse.redirect(url);
}

const timingSafeEqualStr = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a), bufB = Buffer.from(b);
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  const site = process.env.SITE_URL ?? url.origin;
  if (!googleEnabled()) return fail(site, "oauth");

  const jar = await cookies();
  const cookieState = jar.get(STATE_COOKIE)?.value ?? "";
  jar.delete(STATE_COOKIE);

  // Google reports the visitor's own choice not to continue as an error
  // query param, not a missing code — that is not an attack, just a "no".
  if (url.searchParams.get("error")) return fail(site, "oauth_cancelled");

  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  if (!code || !cookieState || !state || !timingSafeEqualStr(state, cookieState)) {
    return fail(site, "oauth");
  }
  // The state we issued is "<random>:<next>"; `next` is re-validated here
  // exactly as a hidden form field would be — the cookie proves the request
  // continues a flow we started, not that its contents are trustworthy.
  const next = safeNext(state.slice(state.indexOf(":") + 1));

  let profile;
  try {
    profile = await googleProfile(code, new URL(REDIRECT_PATH, site).toString());
  } catch {
    return fail(site, "oauth");
  }
  if (!profile.emailVerified) return fail(site, "oauth_unverified");

  const email = profile.email.trim().toLowerCase();
  const existing = await accountByEmail(email);
  let accountId: string, passwordHash: string;
  if (existing) {
    accountId = existing.id;
    passwordHash = existing.password_hash;
    if (!existing.email_verified_at) await markEmailVerified(accountId);
    await audit("signin", { accountId, email, detail: "via Google" });
  } else {
    // An inert, unguessable placeholder: nobody is ever meant to type this.
    // The account remains reachable by "forgot password" later, the same as
    // any other, if its owner wants a password as well.
    const placeholder = crypto.randomBytes(32).toString("base64url");
    const created = await signUp(email, placeholder, { verified: true });
    accountId = created.id;
    passwordHash = created.passwordHash;
    await audit("signup", { accountId, email, detail: "via Google" });
  }

  if (!await startSession(accountId, passwordHash)) return fail(site, "oauth");
  return NextResponse.redirect(new URL(next ?? "/account", site));
}
