import crypto from "node:crypto";
import { logEmail } from "./store";

/** Outbound email.
 *
 *  Provider-agnostic over plain HTTP, so there is no SDK to keep patched and
 *  swapping provider is a function rather than a migration. Resend and
 *  Postmark are wired; both take an API key and nothing else.
 *
 *  Without a key configured, nothing is sent and every message is recorded as
 *  `skipped` with its subject. That matters more than it sounds: the alert
 *  digest is generated from real data either way, so the wiring is exercised
 *  and inspectable before a key exists, rather than being a code path that has
 *  never run.
 */

export type Message = {
  to: string;
  subject: string;
  text: string;
  html: string;
  kind: string;
  accountId?: string | null;
};

export type SendResult = { status: "sent" | "skipped" | "failed"; detail?: string };

const FROM = process.env.HTSDESK_EMAIL_FROM ?? "HTSDesk <alerts@htsdesk.com>";
const REPLY_TO = process.env.HTSDESK_EMAIL_REPLY_TO ?? "hello@htsdesk.com";

export function emailEnabled(): boolean {
  return Boolean(process.env.RESEND_API_KEY || process.env.POSTMARK_API_KEY);
}

export function emailProvider(): string {
  if (process.env.RESEND_API_KEY) return "resend";
  if (process.env.POSTMARK_API_KEY) return "postmark";
  return "none";
}

async function deliver(msg: Message): Promise<SendResult> {
  const resend = process.env.RESEND_API_KEY;
  const postmark = process.env.POSTMARK_API_KEY;

  // Overridable so the delivery path can be exercised against a local
  // catcher in development. Defaults to the real endpoint.
  const resendUrl = process.env.RESEND_API_URL ?? "https://api.resend.com/emails";

  try {
    if (resend) {
      const res = await fetch(resendUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${resend}`, "content-type": "application/json" },
        body: JSON.stringify({
          from: FROM, to: [msg.to], subject: msg.subject,
          text: msg.text, html: msg.html, reply_to: REPLY_TO,
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) return { status: "failed", detail: `resend ${res.status}` };
      return { status: "sent" };
    }

    if (postmark) {
      const res = await fetch("https://api.postmarkapp.com/email", {
        method: "POST",
        headers: {
          "X-Postmark-Server-Token": postmark,
          "content-type": "application/json", accept: "application/json",
        },
        body: JSON.stringify({
          From: FROM, To: msg.to, Subject: msg.subject,
          TextBody: msg.text, HtmlBody: msg.html, ReplyTo: REPLY_TO,
          MessageStream: "outbound",
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) return { status: "failed", detail: `postmark ${res.status}` };
      return { status: "sent" };
    }
  } catch (err) {
    return { status: "failed", detail: err instanceof Error ? err.name : "network error" };
  }

  return { status: "skipped", detail: "no provider configured" };
}

export async function send(msg: Message): Promise<SendResult> {
  const result = await deliver(msg);
  logEmail({
    account_id: msg.accountId ?? null,
    to_address: msg.to,
    kind: msg.kind,
    subject: msg.subject,
    status: result.status,
    detail: result.detail,
  });
  if (result.status === "failed") {
    console.error("email failed", msg.kind, msg.to, result.detail);
  }
  return result;
}

/** Stateless unsubscribe token: an HMAC over the account id.
 *
 *  Stateless so the link in an email keeps working without a session and
 *  without a lookup table, and signed so it cannot be guessed for someone
 *  else's account. */
function secret(): string {
  return process.env.HTSDESK_EMAIL_SECRET ?? process.env.HTSDESK_ADMIN_TOKEN ?? "";
}

export function unsubscribeToken(accountId: string): string {
  return crypto.createHmac("sha256", secret()).update(accountId).digest("base64url");
}

export function verifyUnsubscribe(accountId: string, token: string): boolean {
  if (!secret()) return false;
  const expected = Buffer.from(unsubscribeToken(accountId));
  const given = Buffer.from(token);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}
