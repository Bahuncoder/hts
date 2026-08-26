import crypto from "node:crypto";
import path from "node:path";
import Database from "better-sqlite3";
import { db } from "./store";

/** Change diffing: which published tariff actions touch which customers.
 *
 *  This is the reason a subscription renews. The Federal Register publishes
 *  several tariff actions a week; almost none of them matter to any given
 *  importer, and the one that does is indistinguishable from the rest unless
 *  something matches it against the codes they actually import.
 *
 *  Matching is by code prefix, because an action names the level it operates
 *  at. A notice naming 6109.10 reaches every statistical line beneath it,
 *  including a watched 6109.10.00.12 — so the mention is the prefix and the
 *  watched code is the longer string. Doing it the other way round would
 *  silently miss every heading-level action.
 */

const REFERENCE_DB = process.env.HTSDESK_REFERENCE_DB
  ?? path.join(process.cwd(), "..", "data", "htsdesk.db");

export type TariffAction = {
  document_number: string;
  title: string;
  publication_date: string;
  html_url: string;
  hts_mentions: string;
};

function reference(): Database.Database | null {
  try {
    const d = new Database(REFERENCE_DB, { readonly: true, fileMustExist: true });
    d.pragma("busy_timeout = 5000");
    return d;
  } catch {
    // The reference database is a build artifact; if it is missing the diff
    // should report nothing rather than take the app down.
    return null;
  }
}

export type DiffResult = {
  ran: boolean;
  reason?: string;
  documentsConsidered: number;
  alertsCreated: number;
  accountsNotified: number;
};

export function runDiff(opts: { since?: string; limit?: number } = {}): DiffResult {
  const ref = reference();
  if (!ref) {
    return { ran: false, reason: "reference database unavailable",
             documentsConsidered: 0, alertsCreated: 0, accountsNotified: 0 };
  }

  const d = db();
  const state = d.prepare("SELECT last_seen_date FROM diff_state WHERE id = 1")
    .get() as { last_seen_date: string | null } | undefined;
  // First run looks back far enough to be useful without alerting on history.
  const since = opts.since ?? state?.last_seen_date ?? "1900-01-01";

  const docs = ref.prepare(`
    SELECT document_number, title, publication_date, html_url, hts_mentions
      FROM fr_document
     WHERE tariff_action = 1
       AND hts_mentions != '[]'
       AND publication_date > ?
     ORDER BY publication_date ASC
     LIMIT ?`).all(since, opts.limit ?? 500) as TariffAction[];

  const watched = d.prepare(
    "SELECT DISTINCT account_id, digits, hts FROM watched_code"
  ).all() as { account_id: string; digits: string; hts: string }[];

  ref.close();

  if (!docs.length || !watched.length) {
    stampRun(docs.at(-1)?.publication_date);
    return { ran: true, documentsConsidered: docs.length, alertsCreated: 0,
             accountsNotified: 0 };
  }

  const insert = d.prepare(`
    INSERT OR IGNORE INTO alert(id, account_id, document_number, title,
      publication_date, html_url, digits, hts, created_at)
    VALUES(?,?,?,?,?,?,?,?,?)`);
  const now = new Date().toISOString();
  const touched = new Set<string>();
  let created = 0;

  d.transaction(() => {
    for (const doc of docs) {
      let mentions: string[] = [];
      try { mentions = JSON.parse(doc.hts_mentions) as string[]; } catch { continue; }
      const prefixes = [...new Set(mentions.map((m) => m.replace(/\./g, "")))]
        .filter((m) => m.length >= 6);
      if (!prefixes.length) continue;

      for (const w of watched) {
        // The narrowest matching prefix is the one worth naming in the alert.
        const hit = prefixes
          .filter((p) => w.digits.startsWith(p))
          .sort((a, b) => b.length - a.length)[0];
        if (!hit) continue;
        const res = insert.run(crypto.randomUUID(), w.account_id, doc.document_number,
          doc.title, doc.publication_date, doc.html_url, w.digits, w.hts, now);
        if (res.changes > 0) { created += 1; touched.add(w.account_id); }
      }
    }
    stampRun(docs.at(-1)?.publication_date);
  })();

  return { ran: true, documentsConsidered: docs.length, alertsCreated: created,
           accountsNotified: touched.size };
}

function stampRun(lastSeen?: string) {
  db().prepare(`
    INSERT INTO diff_state(id, last_seen_date, last_run_at) VALUES(1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      last_seen_date = COALESCE(excluded.last_seen_date, diff_state.last_seen_date),
      last_run_at = excluded.last_run_at`)
    .run(lastSeen ?? null, new Date().toISOString());
}

export type Alert = {
  id: string; document_number: string; title: string; publication_date: string;
  html_url: string; digits: string; hts: string; created_at: string;
  read_at: string | null;
};

export function listAlerts(accountId: string, limit = 50): Alert[] {
  return db().prepare(`
    SELECT * FROM alert WHERE account_id = ?
     ORDER BY publication_date DESC, created_at DESC LIMIT ?`)
    .all(accountId, limit) as Alert[];
}

export function unreadCount(accountId: string): number {
  const row = db().prepare(
    "SELECT count(*) AS n FROM alert WHERE account_id = ? AND read_at IS NULL"
  ).get(accountId) as { n: number };
  return row.n;
}

export function markAllRead(accountId: string): void {
  db().prepare("UPDATE alert SET read_at = ? WHERE account_id = ? AND read_at IS NULL")
    .run(new Date().toISOString(), accountId);
}

export function diffStatus() {
  return db().prepare("SELECT last_seen_date, last_run_at FROM diff_state WHERE id = 1")
    .get() as { last_seen_date: string | null; last_run_at: string | null } | undefined;
}

// --- delivery ---------------------------------------------------------------

import { PLANS } from "./plans";
import { renderAlertDigest } from "./emails/alertDigest";
import { emailEnabled, send } from "./email";

export type DeliveryResult = {
  accountsConsidered: number;
  sent: number;
  skippedNoPlan: number;
  skippedOptedOut: number;
  failed: number;
  provider: string;
};

/** Emails one digest per account covering everything not yet sent.
 *
 *  A digest rather than a message per alert: one action commonly names several
 *  of a customer's codes, and sending it once per code reads as spam.
 *
 *  `emailed_at` is stamped for every alert in the batch whatever the outcome —
 *  including when no provider is configured. A run that could not send must
 *  not leave a backlog that floods the customer the day a key is added.
 */
export async function sendAlertDigests(): Promise<DeliveryResult> {
  const d = db();
  const rows = d.prepare(`
    SELECT a.account_id, ac.email, ac.alert_emails, s.plan, s.status
      FROM alert a
      JOIN account ac ON ac.id = a.account_id
      LEFT JOIN subscription s ON s.account_id = a.account_id
     WHERE a.emailed_at IS NULL
     GROUP BY a.account_id`).all() as {
       account_id: string; email: string; alert_emails: number;
       plan: string | null; status: string | null;
     }[];

  const result: DeliveryResult = {
    accountsConsidered: rows.length, sent: 0, skippedNoPlan: 0,
    skippedOptedOut: 0, failed: 0, provider: emailEnabled() ? "configured" : "none",
  };

  const stamp = d.prepare(
    "UPDATE alert SET emailed_at = ? WHERE account_id = ? AND emailed_at IS NULL");

  for (const row of rows) {
    const pending = d.prepare(
      "SELECT * FROM alert WHERE account_id = ? AND emailed_at IS NULL ORDER BY publication_date DESC"
    ).all(row.account_id) as Alert[];
    if (!pending.length) continue;

    const entitled = row.status === "active" || row.status === "trialing";
    const plan = PLANS[(entitled ? row.plan : "free") as keyof typeof PLANS] ?? PLANS.free;

    // Email alerts are a paid feature; the alerts themselves stay visible in
    // the app on every plan, so a free account loses the email, not the fact.
    //
    // Both skips still stamp. An unstamped alert is reconsidered on every
    // later run, and would arrive as a backlog the moment the account
    // upgrades or opts back in — greeting a new subscriber with months of
    // history is the wrong first impression, and the alerts were visible in
    // the app the whole time.
    if (!plan.monitoring) {
      result.skippedNoPlan += 1;
      stamp.run(new Date().toISOString(), row.account_id);
      continue;
    }
    if (row.alert_emails === 0) {
      result.skippedOptedOut += 1;
      stamp.run(new Date().toISOString(), row.account_id);
      continue;
    }

    const digest = renderAlertDigest(row.account_id, pending);
    const outcome = await send({
      to: row.email, subject: digest.subject, text: digest.text, html: digest.html,
      kind: "alert_digest", accountId: row.account_id,
    });

    if (outcome.status === "failed") result.failed += 1;
    else result.sent += outcome.status === "sent" ? 1 : 0;

    // Stamped even when skipped, so enabling a provider does not replay history.
    stamp.run(new Date().toISOString(), row.account_id);
  }

  return result;
}
