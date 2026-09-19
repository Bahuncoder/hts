import { NextResponse } from "next/server";
import { isAdmin, refuse } from "@/lib/adminAuth";
import { renderAlertDigest } from "@/lib/emails/alertDigest";
import { emailProvider } from "@/lib/email";
import { listAlerts } from "@/lib/diff";

export const runtime = "nodejs";

export async function GET(request: Request) {
  if (!isAdmin(request)) return refuse();

  const url = new URL(request.url);
  const account = url.searchParams.get("account");
  if (!account) {
    return NextResponse.json({ error: "pass ?account=<id>" }, { status: 400 });
  }

  const alerts = await listAlerts(account, 20);

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
