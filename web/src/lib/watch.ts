import { db } from "./store";
import { send, emailEnabled } from "./email";

/** Watches the audit log for patterns worth a human's attention.
 *
 *  Recording events is not a control on its own — a log nobody reads is
 *  filing, not security. This runs on the daily job and reports only things
 *  that are unusual enough to act on, because an alert that fires every day
 *  gets filtered into a folder and stops working.
 */

export type Finding = { kind: string; subject: string; count: number; detail: string };

const LOOKBACK_HOURS = 24;

// Thresholds are set above ordinary human error. Someone mistyping a password
// four times is not an incident; twelve failures against one address is.
const FAILED_PER_EMAIL = 12;
const FAILED_PER_CLIENT = 25;
const SPRAY_DISTINCT_EMAILS = 8;

function since(): string {
  return new Date(Date.now() - LOOKBACK_HOURS * 3600_000).toISOString();
}

export function scanAuditLog(): Finding[] {
  const from = since();
  const out: Finding[] = [];

  for (const row of db().prepare(`
    SELECT email, count(*) AS n FROM audit_log
     WHERE event = 'signin_failed' AND at >= ? AND email IS NOT NULL
     GROUP BY email HAVING n >= ? ORDER BY n DESC LIMIT 20`)
    .all(from, FAILED_PER_EMAIL) as { email: string; n: number }[]) {
    out.push({
      kind: "credential_stuffing",
      subject: row.email,
      count: row.n,
      detail: `${row.n} failed sign-ins against one address in ${LOOKBACK_HOURS}h`,
    });
  }

  // Many failures from one client spread over many addresses is spraying,
  // which the per-email limit alone does not catch.
  for (const row of db().prepare(`
    SELECT client, count(*) AS n, count(DISTINCT email) AS emails FROM audit_log
     WHERE event = 'signin_failed' AND at >= ? AND client IS NOT NULL
     GROUP BY client HAVING n >= ? OR emails >= ? ORDER BY n DESC LIMIT 20`)
    .all(from, FAILED_PER_CLIENT, SPRAY_DISTINCT_EMAILS) as
    { client: string; n: number; emails: number }[]) {
    out.push({
      kind: row.emails >= SPRAY_DISTINCT_EMAILS ? "password_spraying" : "brute_force",
      subject: row.client,
      count: row.n,
      detail: `${row.n} failed sign-ins across ${row.emails} address(es) from one client`,
    });
  }

  for (const row of db().prepare(`
    SELECT count(*) AS n FROM audit_log WHERE event = 'signin_throttled' AND at >= ?`)
    .all(from) as { n: number }[]) {
    if (row.n > 0) {
      out.push({
        kind: "throttle_trips",
        subject: "all clients",
        count: row.n,
        detail: `the sign-in throttle refused ${row.n} attempt(s)`,
      });
    }
  }

  // A reset completed without a matching request means a token was used that
  // nobody asked for, which should be impossible.
  const asked = (db().prepare(
    "SELECT count(*) AS n FROM audit_log WHERE event = 'password_reset_requested' AND at >= ?"
  ).get(from) as { n: number }).n;
  const done = (db().prepare(
    "SELECT count(*) AS n FROM audit_log WHERE event = 'password_reset_completed' AND at >= ?"
  ).get(from) as { n: number }).n;
  if (done > asked) {
    out.push({
      kind: "unrequested_reset",
      subject: "password reset",
      count: done - asked,
      detail: `${done} resets completed but only ${asked} requested`,
    });
  }

  return out;
}

export async function reportFindings(findings: Finding[]): Promise<{
  findings: number; notified: boolean;
}> {
  const to = process.env.HTSDESK_SECURITY_EMAIL;
  if (!findings.length || !to || !emailEnabled()) {
    return { findings: findings.length, notified: false };
  }

  const lines = findings.map((f) => `• ${f.kind}: ${f.detail} (${f.subject})`);
  const text = [
    `${findings.length} thing(s) in the last ${LOOKBACK_HOURS} hours look worth a look.`,
    "", ...lines, "",
    "Nothing here is automatically blocked beyond the existing throttles.",
  ].join("\n");

  await send({
    to,
    subject: `HTSDesk: ${findings.length} security finding(s)`,
    text,
    html: `<pre style="font:13px ui-monospace,Menlo,monospace;white-space:pre-wrap">${
      text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre>`,
    kind: "security_digest",
  });
  return { findings: findings.length, notified: true };
}
