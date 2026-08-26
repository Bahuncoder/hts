import crypto from "node:crypto";
import { db } from "./store";
import { clientId } from "./throttle";

/** Security-relevant events.
 *
 *  Written so abuse can be attributed rather than merely blocked, and so a
 *  customer asking "what happened to my account" has an answer. Deliberately
 *  narrow: authentication, credential changes, and destructive or
 *  data-exporting actions. Ordinary browsing is not recorded — a log nobody
 *  can read is not a security control.
 *
 *  Never record a password, a token, or catalogue contents.
 */
export type AuditEvent =
  | "signup"
  | "signin"
  | "signin_failed"
  | "signin_throttled"
  | "signout"
  | "password_reset_requested"
  | "password_reset_completed"
  | "email_verified"
  | "catalogue_saved"
  | "catalogue_deleted"
  | "catalogue_exported"
  | "alert_emails_changed"
  | "plan_changed";

export async function audit(
  event: AuditEvent,
  opts: { accountId?: string | null; email?: string | null; detail?: string } = {},
): Promise<void> {
  try {
    db().prepare(
      "INSERT INTO audit_log(id, account_id, email, event, client, detail, at) VALUES(?,?,?,?,?,?,?)"
    ).run(
      crypto.randomUUID(),
      opts.accountId ?? null,
      opts.email ? opts.email.toLowerCase() : null,
      event,
      await clientId(),
      opts.detail ?? null,
      new Date().toISOString(),
    );
  } catch (err) {
    // An audit failure must never take down the action it describes.
    console.error("audit write failed", event, err);
  }
}

export type AuditRow = {
  id: string; event: AuditEvent; client: string | null;
  detail: string | null; at: string;
};

export function recentForAccount(accountId: string, limit = 20): AuditRow[] {
  return db().prepare(
    "SELECT id, event, client, detail, at FROM audit_log WHERE account_id = ? ORDER BY at DESC LIMIT ?"
  ).all(accountId, limit) as AuditRow[];
}
