import crypto from "node:crypto";
import type { Client } from "@libsql/client";
import { db } from "./store";
import { API_BASE, engineHeaders } from "./api";

/** Change diffing: which published tariff actions touch which customers.
 *
 *  This is why an account is worth keeping. The Federal Register publishes
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

type ChangesPage = {
  changes: TariffAction[];
  has_more?: boolean;
  next_cursor?: string | null;
};

async function fetchPage(params: URLSearchParams): Promise<ChangesPage> {
  const res = await fetch(`${API_BASE}/api/changes?${params}`, {
    headers: engineHeaders(), cache: "no-store", signal: AbortSignal.timeout(30_000),
  });
  // A failed fetch must never look like "nothing changed": the caller would
  // record a successful empty run and move its cursor past unread documents.
  if (!res.ok) throw new Error(`engine API responded ${res.status}`);
  const body = (await res.json()) as ChangesPage;
  if (!Array.isArray(body.changes)) throw new Error("engine API returned no change list");
  return body;
}

/** Every document from `since` (inclusive) onwards, oldest first, following
 *  the engine's composite cursor so a date split across pages loses nothing. */
async function fetchChanges(since: string, limit: number) {
  const docs: TariffAction[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor) params.set("cursor", cursor); else params.set("since", since);
    const body = await fetchPage(params);
    docs.push(...body.changes);
    if (!body.has_more) return { docs, cursor: body.next_cursor ?? cursor, truncated: false };
    if (!body.next_cursor || body.next_cursor === cursor) {
      throw new Error("engine API reported more changes without advancing its cursor");
    }
    cursor = body.next_cursor;
  }
  return { docs, cursor, truncated: true };
}

const MAX_PAGES = 200;

/** Each run re-reads this many days behind the stored cursor. A document the
 *  engine ingests late carries its (older) publication date, which the cursor
 *  alone would never revisit; INSERT OR IGNORE on the alert's unique key makes
 *  the replay free. A document ingested more than this late is not seen. */
const LOOKBACK_DAYS = 7;
/** With no stored position (a new install, or one whose cursor was lost) the
 *  run starts this far back rather than at the beginning of time: alerting
 *  every watcher about all of history, and emailing them a digest of
 *  it, is the wrong first impression. An explicit `since` still backfills. */
const FIRST_RUN_DAYS = 30;

function daysBefore(isoDate: string, days: number): string {
  const d = new Date(`${isoDate.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export type DiffResult = {
  ran: boolean;
  reason?: string;
  truncated?: boolean;
  documentsConsidered: number;
  alertsCreated: number;
  accountsNotified: number;
};

type DiffState = { last_seen_date: string | null; cursor: string | null };

/** `limit` is the page size. The persisted cursor only moves once every page
 *  has been read and the alerts committed, so a failed run is simply retried
 *  from the same place. */
export async function runDiff(opts: { since?: string; limit?: number } = {}): Promise<DiffResult> {
  const c = await db();
  const stateRs = await c.execute("SELECT last_seen_date, cursor FROM diff_state WHERE id = 1");
  const state = stateRs.rows[0] as unknown as DiffState | undefined;
  const position = state?.cursor ?? state?.last_seen_date ?? null;
  const since = opts.since ?? daysBefore(
    position ?? new Date().toISOString().slice(0, 10),
    position ? LOOKBACK_DAYS : FIRST_RUN_DAYS);

  let fetched: Awaited<ReturnType<typeof fetchChanges>>;
  try {
    fetched = await fetchChanges(since, opts.limit ?? 500);
  } catch (err) {
    return { ran: false, reason: `engine API unavailable: ${err instanceof Error ? err.message : err}`,
             documentsConsidered: 0, alertsCreated: 0, accountsNotified: 0 };
  }
  const { docs, truncated } = fetched;
  // Never move backwards: a manual backfill from an early `since` must not
  // rewind the position a routine run has already reached.
  const cursor = fetched.cursor && (!state?.cursor || fetched.cursor > state.cursor)
    ? fetched.cursor : state?.cursor ?? null;

  const watchedRs = await c.execute("SELECT DISTINCT account_id, digits, hts FROM watched_code");
  const watched = watchedRs.rows as unknown as { account_id: string; digits: string; hts: string }[];

  if (!docs.length || !watched.length) {
    await stampRun(c, cursor);
    return { ran: true, truncated, documentsConsidered: docs.length, alertsCreated: 0,
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
    await tx.execute({ sql: STAMP_RUN_SQL, args: stampArgs(cursor) });
    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  }

  return { ran: true, truncated, documentsConsidered: docs.length, alertsCreated: created,
           accountsNotified: touched.size };
}

const STAMP_RUN_SQL = `
  INSERT INTO diff_state(id, last_seen_date, cursor, last_run_at) VALUES(1, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    last_seen_date = COALESCE(excluded.last_seen_date, diff_state.last_seen_date),
    cursor = COALESCE(excluded.cursor, diff_state.cursor),
    last_run_at = excluded.last_run_at`;

function stampArgs(cursor: string | null) {
  return [cursor?.split("|")[0] ?? null, cursor, new Date().toISOString()];
}

async function stampRun(c: Client, cursor: string | null) {
  await c.execute({ sql: STAMP_RUN_SQL, args: stampArgs(cursor) });
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

import { renderAlertDigest } from "./emails/alertDigest";
import { emailEnabled, send } from "./email";

export type DeliveryResult = {
  accountsConsidered: number;
  sent: number;
  skippedOptedOut: number;
  skippedNoProvider: number;
  /** Accounts whose send failed this run; their alerts stay queued. */
  failed: number;
  /** Alerts abandoned after MAX_EMAIL_ATTEMPTS failed sends. */
  failedPermanent: number;
  provider: string;
};

/** A claim this old belongs to a run that died mid-send. */
const CLAIM_STALE_MS = 5 * 60_000;
const MAX_EMAIL_ATTEMPTS = 5;

/** Emails one digest per account covering the alerts not yet finished.
 *
 *  A digest rather than a message per alert: one action commonly names several
 *  of a customer's codes, and sending it once per code reads as spam.
 *
 *  This is an outbox. A run first CLAIMS the exact alert ids it will send, so
 *  a concurrent run cannot pick the same batch, renders the digest from only
 *  those ids, and finishes only those ids: an alert inserted mid-send is not
 *  marked delivered. A failed send releases the claim and is retried on the
 *  next run, up to MAX_EMAIL_ATTEMPTS.
 *
 *  Every account gets alert emails. Outcomes that are deliberate — the
 *  customer opted out, no provider configured — still stamp `emailed_at`,
 *  because a run that could not send must not leave a backlog that floods the
 *  customer the day they opt back in or a key is added. `email_status`
 *  records which outcome it was, so those stay distinguishable from failures.
 */
export async function sendAlertDigests(): Promise<DeliveryResult> {
  const c = await db();
  const staleBefore = () => new Date(Date.now() - CLAIM_STALE_MS).toISOString();
  const rowsRs = await c.execute({
    sql: `SELECT a.account_id, ac.email, ac.alert_emails
      FROM alert a
      JOIN account ac ON ac.id = a.account_id
     WHERE a.emailed_at IS NULL
       AND (a.email_claimed_at IS NULL OR a.email_claimed_at < ?)
     GROUP BY a.account_id`,
    args: [staleBefore()],
  });
  const rows = rowsRs.rows as unknown as {
    account_id: string; email: string; alert_emails: number;
  }[];

  const result: DeliveryResult = {
    accountsConsidered: rows.length, sent: 0, skippedOptedOut: 0,
    skippedNoProvider: 0, failed: 0, failedPermanent: 0,
    provider: emailEnabled() ? "configured" : "none",
  };

  for (const row of rows) {
    const claim = crypto.randomUUID();
    const claimed = await c.execute({
      sql: `UPDATE alert SET email_claim = ?, email_claimed_at = ?
             WHERE account_id = ? AND emailed_at IS NULL
               AND (email_claimed_at IS NULL OR email_claimed_at < ?)`,
      args: [claim, new Date().toISOString(), row.account_id, staleBefore()],
    });
    if (!claimed.rowsAffected) continue; // another run took it

    const pendingRs = await c.execute({
      sql: "SELECT * FROM alert WHERE email_claim = ? AND emailed_at IS NULL ORDER BY publication_date DESC",
      args: [claim],
    });
    const pending = pendingRs.rows as unknown as Alert[];
    const ids = pending.map((a) => a.id);
    if (!ids.length) continue;

    const finish = (status: string) => c.execute({
      sql: `UPDATE alert SET emailed_at = ?, email_status = ?, email_claim = NULL
             WHERE emailed_at IS NULL AND id IN (${ids.map(() => "?").join(",")})`,
      args: [new Date().toISOString(), status, ...ids],
    });

    if (row.alert_emails === 0) {
      result.skippedOptedOut += 1;
      await finish("skipped_opt_out");
      continue;
    }

    let outcome: { status: "sent" | "skipped" | "failed"; detail?: string };
    try {
      const digest = renderAlertDigest(row.account_id, pending);
      outcome = await send({
        to: row.email, subject: digest.subject, text: digest.text, html: digest.html,
        kind: "alert_digest", accountId: row.account_id,
      });
    } catch (err) {
      outcome = { status: "failed", detail: err instanceof Error ? err.message : String(err) };
    }

    if (outcome.status === "sent") {
      result.sent += 1;
      await finish("sent");
    } else if (outcome.status === "skipped") {
      result.skippedNoProvider += 1;
      await finish("skipped_no_provider");
    } else {
      result.failed += 1;
      const marks = ids.map(() => "?").join(",");
      await c.execute({
        sql: `UPDATE alert
                 SET email_attempts = email_attempts + 1, email_last_error = ?,
                     email_claim = NULL, email_claimed_at = NULL,
                     emailed_at = CASE WHEN email_attempts + 1 >= ? THEN ? ELSE NULL END,
                     email_status = CASE WHEN email_attempts + 1 >= ? THEN 'failed_permanent'
                                         ELSE email_status END
               WHERE email_claim = ? AND emailed_at IS NULL AND id IN (${marks})`,
        args: [outcome.detail ?? "send failed", MAX_EMAIL_ATTEMPTS, new Date().toISOString(),
          MAX_EMAIL_ATTEMPTS, claim, ...ids],
      });
      const gone = await c.execute({
        sql: `SELECT count(*) AS n FROM alert
               WHERE email_status = 'failed_permanent' AND id IN (${marks})`,
        args: ids,
      });
      const dead = (gone.rows[0] as unknown as { n: number }).n;
      if (dead) {
        result.failedPermanent += dead;
        console.error("alert email abandoned after", MAX_EMAIL_ATTEMPTS, "attempts",
          row.account_id, dead, outcome.detail);
      }
    }
  }

  return result;
}
