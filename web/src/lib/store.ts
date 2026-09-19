import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createClient, type Client, type InArgs } from "@libsql/client";

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

  // A database created when HTSDesk sold paid plans still holds `subscription`
  // and `webhook_event` tables. Nothing reads or writes them now, and they are
  // deliberately neither dropped nor altered here: no destructive migration,
  // and the rows stay available should they ever be needed. New databases do
  // not create them.
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

    -- Work already done by a caller of the public proxies (audit requests,
    -- audited items), so a budget holds across workers and deploys.
    CREATE TABLE IF NOT EXISTS usage_event (
      scope   TEXT NOT NULL,
      subject TEXT NOT NULL,
      at      TEXT NOT NULL,
      cost    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS usage_key ON usage_event(scope, subject, at);

    -- At most one in-flight expensive call per subject. The expiry is what
    -- frees a lease held by a request that died without releasing it.
    CREATE TABLE IF NOT EXISTS usage_lease (
      subject    TEXT PRIMARY KEY,
      token      TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
  `);
  await migrate(c);

  if (!REMOTE_URL) {
    try { fs.chmodSync(LOCAL_PATH, 0o600); } catch { /* not ours to change */ }
  }
}

/** Additive column migrations. SQLite has no IF NOT EXISTS for ADD COLUMN, so
 *  the current columns are read first. */
async function addColumns(c: Client, table: string, columns: Record<string, string>): Promise<void> {
  const info = await c.execute(`PRAGMA table_info(${table})`);
  const have = new Set(info.rows.map((r) => r.name as string));
  for (const [name, ddl] of Object.entries(columns)) {
    if (!have.has(name)) await c.execute(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
  }
}

async function migrate(c: Client): Promise<void> {
  await addColumns(c, "account", {
    alert_emails: "INTEGER NOT NULL DEFAULT 1",
    email_verified_at: "TEXT",
  });
  // email_status stays NULL until an alert is finished: sent, skipped_opt_out,
  // skipped_no_provider or failed_permanent. (Older rows may carry
  // skipped_plan, from when alert emails were a paid feature; it is history
  // and is left as it is.) emailed_at is stamped for every finished alert so
  // history is never replayed.
  await addColumns(c, "alert", {
    email_status: "TEXT",
    email_attempts: "INTEGER NOT NULL DEFAULT 0",
    email_last_error: "TEXT",
    email_claim: "TEXT",
    email_claimed_at: "TEXT",
  });
  // cursor is the composite "publication_date|document_number" position the
  // engine's /api/changes pages by; last_seen_date is kept for display.
  await addColumns(c, "diff_state", { cursor: "TEXT" });
  // A saved catalogue keeps every line of the audit it came from, including
  // the ones that could not be priced, plus the state they were in. Rows saved
  // before this have status NULL and are labelled as such rather than
  // guessed at.
  await addColumns(c, "catalogue_item", {
    row_number: "INTEGER",
    status: "TEXT",
    error: "TEXT",
    review_json: "TEXT",
    warnings_json: "TEXT",
    incomplete_json: "TEXT",
  });
  // What the whole audit rested on: the reference-data revision, the stated
  // assumptions, whether the totals were complete, and when the engine
  // calculated them. mpf is the entry-level fee, which no single line carries.
  await addColumns(c, "catalogue", {
    dataset_revision: "TEXT",
    assumptions_json: "TEXT",
    totals_complete: "INTEGER",
    calculated_at: "TEXT",
    mpf: "REAL",
  });
}

/** Convenience wrapper: opens the connection and runs one statement. */
async function run(sql: string, args: InArgs = []) {
  return (await db()).execute({ sql, args });
}

export type Account = {
  id: string; email: string; created_at: string;
  alert_emails?: number; email_verified_at?: string | null;
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
  await run(
    "INSERT INTO account(id, email, password_hash, created_at) VALUES(?, ?, ?, ?)",
    [id, email, passwordHash, new Date().toISOString()],
  );
}
