import crypto from "node:crypto";
import type { Client } from "@libsql/client";
import { db } from "./store";
import { API_BASE, engineHeaders } from "./api";

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
 *
 *  Documents come from the engine API's /api/changes, not a local read of
 *  the reference database: the web tier has no persistent disk of its own in
 *  production, so the reference data lives only behind the API.
 */

export type TariffAction = {
  document_number: string;
  title: string;
  publication_date: string;
  html_url: string;
  hts_mentions: string[];
};

async function fetchChanges(since: string, limit: number): Promise<TariffAction[]> {
  const url = `${API_BASE}/api/changes?since=${encodeURIComponent(since)}&limit=${limit}`;
  const res = await fetch(url, { headers: engineHeaders(), cache: "no-store" });
  if (!res.ok) return [];
  const body = (await res.json()) as { changes: TariffAction[] };
  return body.changes ?? [];
}

export type DiffResult = {
  ran: boolean;
  reason?: string;
  documentsConsidered: number;
  alertsCreated: number;
  accountsNotified: number;
};

export async function runDiff(opts: { since?: string; limit?: number } = {}): Promise<DiffResult> {
  const c = await db();
  const stateRs = await c.execute("SELECT last_seen_date FROM diff_state WHERE id = 1");
  const state = stateRs.rows[0] as unknown as { last_seen_date: string | null } | undefined;
  // First run looks back far enough to be useful without alerting on history.
  const since = opts.since ?? state?.last_seen_date ?? "1900-01-01";

  let docs: TariffAction[];
  try {
    docs = await fetchChanges(since, opts.limit ?? 500);
  } catch {
    return { ran: false, reason: "engine API unavailable",
             documentsConsidered: 0, alertsCreated: 0, accountsNotified: 0 };
  }

  const watchedRs = await c.execute("SELECT DISTINCT account_id, digits, hts FROM watched_code");
  const watched = watchedRs.rows as unknown as { account_id: string; digits: string; hts: string }[];

  if (!docs.length || !watched.length) {
    await stampRun(c, docs.at(-1)?.publication_date);
    return { ran: true, documentsConsidered: docs.length, alertsCreated: 0,
             accountsNotified: 0 };
  }

  const now = new Date().toISOString();
  const touched = new Set<string>();
  let created = 0;

  const tx = await c.transaction("write");
  try {
    for (const doc of docs) {
      const mentions = Array.isArray(doc.hts_mentions) ? doc.hts_mentions : [];
      const prefixes = [...new Set(mentions.map((m) => m.replace(/\./g, "")))]
        .filter((m) => m.length >= 6);
      if (!prefixes.length) continue;

      for (const w of watched) {
        // The narrowest matching prefix is the one worth naming in the alert.
        const hit = prefixes
          .filter((p) => w.digits.startsWith(p))
          .sort((a, b) => b.length - a.length)[0];
        if (!hit) continue;
        const res = await tx.execute({
          sql: `INSERT OR IGNORE INTO alert(id, account_id, document_number, title,
                  publication_date, html_url, digits, hts, created_at)
                VALUES(?,?,?,?,?,?,?,?,?)`,
          args: [crypto.randomUUID(), w.account_id, doc.document_number,
            doc.title, doc.publication_date, doc.html_url, w.digits, w.hts, now],
        });
        if (res.rowsAffected > 0) { created += 1; touched.add(w.account_id); }
      }
    }
    await tx.execute({
      sql: STAMP_RUN_SQL,
      args: [docs.at(-1)?.publication_date ?? null, new Date().toISOString()],
    });
    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  }

  return { ran: true, documentsConsidered: docs.length, alertsCreated: created,
           accountsNotified: touched.size };
}

const STAMP_RUN_SQL = `
  INSERT INTO diff_state(id, last_seen_date, last_run_at) VALUES(1, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    last_seen_date = COALESCE(excluded.last_seen_date, diff_state.last_seen_date),
    last_run_at = excluded.last_run_at`;

async function stampRun(c: Client, lastSeen?: string) {
  await c.execute({ sql: STAMP_RUN_SQL, args: [lastSeen ?? null, new Date().toISOString()] });
}

export type Alert = {
  id: string; document_number: string; title: string; publication_date: string;
  html_url: string; digits: string; hts: string; created_at: string;
  read_at: string | null;
};

export async function listAlerts(accountId: string, limit = 50): Promise<Alert[]> {
  const rs = await (await db()).execute({
    sql: `SELECT * FROM alert WHERE account_id = ?
           ORDER BY publication_date DESC, created_at DESC LIMIT ?`,
    args: [accountId, limit],
  });
  return rs.rows as unknown as Alert[];
}

export async function unreadCount(accountId: string): Promise<number> {
  const rs = await (await db()).execute({
    sql: "SELECT count(*) AS n FROM alert WHERE account_id = ? AND read_at IS NULL",
    args: [accountId],
  });
  return (rs.rows[0] as unknown as { n: number }).n;
}

export async function markAllRead(accountId: string): Promise<void> {
  await (await db()).execute({
    sql: "UPDATE alert SET read_at = ? WHERE account_id = ? AND read_at IS NULL",
    args: [new Date().toISOString(), accountId],
  });
}

export async function diffStatus() {
  const rs = await (await db()).execute("SELECT last_seen_date, last_run_at FROM diff_state WHERE id = 1");
  return rs.rows[0] as unknown as { last_seen_date: string | null; last_run_at: string | null } | undefined;
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
  const c = await db();
  const rowsRs = await c.execute(`
    SELECT a.account_id, ac.email, ac.alert_emails, s.plan, s.status
      FROM alert a
      JOIN account ac ON ac.id = a.account_id
      LEFT JOIN subscription s ON s.account_id = a.account_id
     WHERE a.emailed_at IS NULL
     GROUP BY a.account_id`);
  const rows = rowsRs.rows as unknown as {
    account_id: string; email: string; alert_emails: number;
    plan: string | null; status: string | null;
  }[];

  const result: DeliveryResult = {
    accountsConsidered: rows.length, sent: 0, skippedNoPlan: 0,
    skippedOptedOut: 0, failed: 0, provider: emailEnabled() ? "configured" : "none",
  };

  const stamp = async (accountId: string) => c.execute({
    sql: "UPDATE alert SET emailed_at = ? WHERE account_id = ? AND emailed_at IS NULL",
    args: [new Date().toISOString(), accountId],
  });

  for (const row of rows) {
    const pendingRs = await c.execute({
      sql: "SELECT * FROM alert WHERE account_id = ? AND emailed_at IS NULL ORDER BY publication_date DESC",
      args: [row.account_id],
    });
    const pending = pendingRs.rows as unknown as Alert[];
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
      await stamp(row.account_id);
      continue;
    }
    if (row.alert_emails === 0) {
      result.skippedOptedOut += 1;
      await stamp(row.account_id);
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
    await stamp(row.account_id);
  }

  return result;
}
