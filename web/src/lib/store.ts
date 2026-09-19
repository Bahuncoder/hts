import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createClient, type Client, type InArgs } from "@libsql/client";
import type { PlanId } from "./plans";

/** Account store.
 *
 *  Separate from the reference database, which is read-only and rebuilt from
 *  public sources. This one is the only thing we cannot regenerate.
 *
 *  Backed by libSQL: a remote Turso database in production (no persistent
 *  local disk on Vercel to keep a SQLite file on), or a local embedded file
 *  in development (TURSO_DATABASE_URL unset). Same SQL dialect either way,
 *  so the schema below is unchanged from the original better-sqlite3 version
 *  — only the client is async now.
 */
const LOCAL_PATH = process.env.HTSDESK_ACCOUNTS_DB
  ?? path.join(process.cwd(), "..", "data", "accounts.db");
const REMOTE_URL = process.env.TURSO_DATABASE_URL;
const DB_URL = REMOTE_URL ?? `file:${LOCAL_PATH}`;

let _client: Client | null = null;
let _ready: Promise<void> | null = null;

function client(): Client {
  if (!_client) {
    _client = createClient({ url: DB_URL, authToken: process.env.TURSO_AUTH_TOKEN });
  }
  return _client;
}

/** Resolves once the connection is open and the schema exists. Cached across
 *  calls in the same warm instance so every query does not re-run DDL. */
export async function db(): Promise<Client> {
  const c = client();
  if (!_ready) _ready = init(c);
  await _ready;
  return c;
}

async function init(c: Client): Promise<void> {
  if (!REMOTE_URL) {
    // Every account, catalogue and alert lives in this file. SQLite creates
    // it with the process umask, which on a default box leaves it
    // world-readable.
    await c.execute("PRAGMA journal_mode = WAL");
    await c.execute("PRAGMA busy_timeout = 5000");
  }

  await c.executeMultiple(`
    CREATE TABLE IF NOT EXISTS account (
      id            TEXT PRIMARY KEY,
      email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      created_at    TEXT NOT NULL
    );

    -- Delivery log. One row per message we attempted, so a failure is
    -- visible and a retry cannot silently double-send.
    CREATE TABLE IF NOT EXISTS email_log (
      id          TEXT PRIMARY KEY,
      account_id  TEXT REFERENCES account(id) ON DELETE CASCADE,
      to_address  TEXT NOT NULL,
      kind        TEXT NOT NULL,
      subject     TEXT,
      status      TEXT NOT NULL,
      detail      TEXT,
      created_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS email_account ON email_log(account_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS session (
      token      TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS session_account ON session(account_id);

    -- One row per account. Stripe is the source of truth; this mirrors it so
    -- a page render never has to call Stripe.
    CREATE TABLE IF NOT EXISTS subscription (
      account_id          TEXT PRIMARY KEY REFERENCES account(id) ON DELETE CASCADE,
      stripe_customer_id  TEXT,
      stripe_subscription_id TEXT,
      plan                TEXT NOT NULL DEFAULT 'free',
      status              TEXT NOT NULL DEFAULT 'active',
      current_period_end  TEXT,
      updated_at          TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sub_customer ON subscription(stripe_customer_id);

    -- A catalogue is the unit a customer keeps and we monitor. Items carry
    -- the classification as decided at save time, so a later change to our
    -- ranking cannot silently rewrite what someone reviewed and accepted.
    CREATE TABLE IF NOT EXISTS catalogue (
      id         TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS catalogue_account ON catalogue(account_id);

    CREATE TABLE IF NOT EXISTS catalogue_item (
      id            TEXT PRIMARY KEY,
      catalogue_id  TEXT NOT NULL REFERENCES catalogue(id) ON DELETE CASCADE,
      sku           TEXT,
      description   TEXT NOT NULL,
      country       TEXT NOT NULL,
      value         REAL NOT NULL,
      hts           TEXT,
      digits        TEXT,
      confidence    TEXT,
      duty          REAL,
      effective_rate REAL,
      refundable    REAL,
      scope_unverified INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS item_catalogue ON catalogue_item(catalogue_id);
    CREATE INDEX IF NOT EXISTS item_digits ON catalogue_item(digits);

    -- Codes an account wants to hear about. Saving a catalogue watches every
    -- code in it; a code can also be watched on its own from a code page.
    CREATE TABLE IF NOT EXISTS watched_code (
      account_id   TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
      digits       TEXT NOT NULL,
      hts          TEXT NOT NULL,
      catalogue_id TEXT REFERENCES catalogue(id) ON DELETE CASCADE,
      created_at   TEXT NOT NULL,
      PRIMARY KEY (account_id, digits, catalogue_id)
    );
    CREATE INDEX IF NOT EXISTS watch_digits ON watched_code(digits);
    CREATE INDEX IF NOT EXISTS watch_account ON watched_code(account_id);

    -- One row per (account, document, code) the diff matched. The unique key
    -- is what stops a re-run alerting the same person twice for one action.
    CREATE TABLE IF NOT EXISTS alert (
      id              TEXT PRIMARY KEY,
      account_id      TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
      document_number TEXT NOT NULL,
      title           TEXT,
      publication_date TEXT,
      html_url        TEXT,
      digits          TEXT NOT NULL,
      hts             TEXT NOT NULL,
      created_at      TEXT NOT NULL,
      read_at         TEXT,
      emailed_at      TEXT,
      UNIQUE (account_id, document_number, digits)
    );
    CREATE INDEX IF NOT EXISTS alert_account ON alert(account_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS alert_unread ON alert(account_id) WHERE read_at IS NULL;

    -- How far the diff has read, so a run only considers new documents.
    CREATE TABLE IF NOT EXISTS diff_state (
      id            INTEGER PRIMARY KEY CHECK (id = 1),
      last_seen_date TEXT,
      last_run_at   TEXT
    );

    -- Credential throttling. In the database rather than process memory so
    -- the limit holds across workers and across instances sharing this file;
    -- an in-process counter multiplies the real limit by the worker count.
    CREATE TABLE IF NOT EXISTS auth_attempt (
      scope      TEXT NOT NULL,
      subject    TEXT NOT NULL,
      at         TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS attempt_key ON auth_attempt(scope, subject, at);

    -- Single-use, expiring tokens for password reset and email verification.
    -- Only the hash is stored: a leaked database must not yield working links.
    CREATE TABLE IF NOT EXISTS auth_token (
      token_hash TEXT PRIMARY KEY,
      kind       TEXT NOT NULL,
      account_id TEXT REFERENCES account(id) ON DELETE CASCADE,
      email      TEXT,
      payload    TEXT,
      expires_at TEXT NOT NULL,
      used_at    TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS token_account ON auth_token(account_id, kind);
    CREATE INDEX IF NOT EXISTS token_expiry ON auth_token(expires_at);

    -- Security-relevant events, so abuse can be attributed and a customer can
    -- be told what happened to their account.
    CREATE TABLE IF NOT EXISTS audit_log (
      id         TEXT PRIMARY KEY,
      account_id TEXT,
      email      TEXT,
      event      TEXT NOT NULL,
      client     TEXT,
      detail     TEXT,
      at         TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS audit_account ON audit_log(account_id, at DESC);
    CREATE INDEX IF NOT EXISTS audit_event ON audit_log(event, at DESC);

    -- Webhook ids we have already applied. Stripe retries and can deliver the
    -- same event more than once; without this a retry could downgrade an
    -- account that has since upgraded.
    CREATE TABLE IF NOT EXISTS webhook_event (
      id          TEXT PRIMARY KEY,
      type        TEXT,
      received_at TEXT NOT NULL
    );
  `);
  await migrate(c);

  if (!REMOTE_URL) {
    try { fs.chmodSync(LOCAL_PATH, 0o600); } catch { /* not ours to change */ }
  }
}

/** Additive column migrations. SQLite has no IF NOT EXISTS for ADD COLUMN, so
 *  the current columns are read first. */
async function migrate(c: Client): Promise<void> {
  const info = await c.execute("PRAGMA table_info(account)");
  const cols = new Set(info.rows.map((r) => r.name as string));
  if (!cols.has("alert_emails")) {
    await c.execute("ALTER TABLE account ADD COLUMN alert_emails INTEGER NOT NULL DEFAULT 1");
  }
  if (!cols.has("email_verified_at")) {
    await c.execute("ALTER TABLE account ADD COLUMN email_verified_at TEXT");
  }
}

/** Convenience wrapper: opens the connection and runs one statement. */
async function run(sql: string, args: InArgs = []) {
  return (await db()).execute({ sql, args });
}

export type Account = {
  id: string; email: string; created_at: string;
  alert_emails?: number; email_verified_at?: string | null;
};
export type Subscription = {
  account_id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  plan: PlanId;
  status: string;
  current_period_end: string | null;
};

export async function accountByEmail(email: string) {
  const rs = await run("SELECT * FROM account WHERE email = ?", [email]);
  return rs.rows[0] as unknown as (Account & { password_hash: string }) | undefined;
}

export async function accountById(id: string) {
  const rs = await run(
    "SELECT id, email, created_at, alert_emails, email_verified_at FROM account WHERE id = ?",
    [id],
  );
  return rs.rows[0] as unknown as Account | undefined;
}

export async function setAlertEmails(accountId: string, on: boolean): Promise<void> {
  await run("UPDATE account SET alert_emails = ? WHERE id = ?", [on ? 1 : 0, accountId]);
}

export async function logEmail(row: {
  account_id: string | null; to_address: string; kind: string;
  subject: string; status: string; detail?: string;
}): Promise<void> {
  await run(`
    INSERT INTO email_log(id, account_id, to_address, kind, subject, status, detail, created_at)
    VALUES(?,?,?,?,?,?,?,?)`, [
    crypto.randomUUID(), row.account_id, row.to_address, row.kind,
    row.subject, row.status, row.detail ?? null, new Date().toISOString(),
  ]);
}

export async function createAccount(id: string, email: string, passwordHash: string): Promise<void> {
  const now = new Date().toISOString();
  const c = await db();
  const tx = await c.transaction("write");
  try {
    await tx.execute({
      sql: "INSERT INTO account(id, email, password_hash, created_at) VALUES(?, ?, ?, ?)",
      args: [id, email, passwordHash, now],
    });
    await tx.execute({
      sql: "INSERT INTO subscription(account_id, plan, status, updated_at) VALUES(?, 'free', 'active', ?)",
      args: [id, now],
    });
    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

export async function subscriptionFor(accountId: string): Promise<Subscription> {
  const rs = await run("SELECT * FROM subscription WHERE account_id = ?", [accountId]);
  const row = rs.rows[0] as unknown as Subscription | undefined;
  return row ?? {
    account_id: accountId, stripe_customer_id: null, stripe_subscription_id: null,
    plan: "free", status: "active", current_period_end: null,
  };
}

export async function upsertSubscription(s: Partial<Subscription> & { account_id: string }): Promise<void> {
  const now = new Date().toISOString();
  await run(`
    INSERT INTO subscription(account_id, stripe_customer_id, stripe_subscription_id,
                             plan, status, current_period_end, updated_at)
    VALUES(:account_id, :stripe_customer_id, :stripe_subscription_id,
           :plan, :status, :current_period_end, :updated_at)
    ON CONFLICT(account_id) DO UPDATE SET
      stripe_customer_id     = COALESCE(excluded.stripe_customer_id, subscription.stripe_customer_id),
      stripe_subscription_id = excluded.stripe_subscription_id,
      plan                   = excluded.plan,
      status                 = excluded.status,
      current_period_end     = excluded.current_period_end,
      updated_at             = excluded.updated_at
  `, {
    account_id: s.account_id,
    stripe_customer_id: s.stripe_customer_id ?? null,
    stripe_subscription_id: s.stripe_subscription_id ?? null,
    plan: s.plan ?? "free",
    status: s.status ?? "active",
    current_period_end: s.current_period_end ?? null,
    updated_at: now,
  });
}

export async function accountForCustomer(customerId: string): Promise<string | null> {
  const rs = await run(
    "SELECT account_id FROM subscription WHERE stripe_customer_id = ?", [customerId],
  );
  const row = rs.rows[0] as unknown as { account_id: string } | undefined;
  return row?.account_id ?? null;
}

/** True the first time an event id is seen; false on a redelivery. */
export async function claimWebhookEvent(id: string, type: string): Promise<boolean> {
  try {
    await run(
      "INSERT INTO webhook_event(id, type, received_at) VALUES(?, ?, ?)",
      [id, type, new Date().toISOString()],
    );
    return true;
  } catch {
    return false;
  }
}
