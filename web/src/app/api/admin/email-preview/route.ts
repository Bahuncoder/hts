import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { renderAlertDigest } from "@/lib/emails/alertDigest";
import { emailProvider } from "@/lib/email";
import { db } from "@/lib/store";
import type { Alert } from "@/lib/diff";

export const runtime = "nodejs";

/** Renders the digest an account would receive, without sending it.
 *
 *  Email is the one output nobody sees until it lands in a stranger's inbox.
 *  This makes it inspectable — before a provider key exists, and afterwards
 *  when checking a template change.
 */
function authorised(request: Request): boolean {
  const expected = process.env.HTSDESK_ADMIN_TOKEN;
  if (!expected) return false;
  const given = request.headers.get("x-admin-token") ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function GET(request: Request) {
  if (!authorised(request)) {
    return NextResponse.json({ error: "not authorised" }, { status: 401 });
  }

  const url = new URL(request.url);
  const account = url.searchParams.get("account");
  if (!account) {
    return NextResponse.json({ error: "pass ?account=<id>" }, { status: 400 });
  }

  const alerts = db().prepare(
    "SELECT * FROM alert WHERE account_id = ? ORDER BY publication_date DESC LIMIT 20"
  ).all(account) as Alert[];

  if (!alerts.length) {
    return NextResponse.json({ error: "no alerts for that account" }, { status: 404 });
  }

  const digest = renderAlertDigest(account, alerts);

  if (url.searchParams.get("format") === "html") {
    return new NextResponse(digest.html, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  return NextResponse.json({
    provider: emailProvider(),
    alerts: alerts.length,
    subject: digest.subject,
    text: digest.text,
  });
}
