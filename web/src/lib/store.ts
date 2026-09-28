import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createClient, type Client, type InArgs } from "@libsql/client";
import { LIMITS, PLAN_LIMITS, type Limits, type PlanId } from "./plans";

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

    -- One row per account. Stripe is the source of truth; this mirrors it so
    -- a page render never has to call Stripe. A database created when
    -- HTSDesk first sold paid plans already has this table, in this exact
    -- shape -- CREATE TABLE IF NOT EXISTS is a true no-op against it.
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

    -- Webhook ids with a durable processing state (see migrate() for the
    -- status columns). Stripe retries and can deliver the same event more than
    -- once; only a SUCCEEDED id is a duplicate, a failed one must be redone.
    -- Already exists, in this shape, in a database created when HTSDesk first
    -- sold paid plans -- CREATE TABLE IF NOT EXISTS is a no-op against it.
    CREATE TABLE IF NOT EXISTS webhook_event (
      id          TEXT PRIMARY KEY,
      type        TEXT,
      received_at TEXT NOT NULL
    );

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

    -- A B2B customer's programmatic credential. Only its hash is stored --
    -- the raw secret is shown once at creation and cannot be recovered.
    -- prefix is enough to tell keys apart in the management UI without
    -- re-exposing the secret. Revocation is a timestamp, not a delete, so a
    -- revoked key's history (last_used_at) survives for support/debugging.
    CREATE TABLE IF NOT EXISTS api_key (
      id          TEXT PRIMARY KEY,
      account_id  TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      prefix      TEXT NOT NULL,
      hash        TEXT NOT NULL UNIQUE,
      created_at  TEXT NOT NULL,
      last_used_at TEXT,
      revoked_at  TEXT
    );
    CREATE INDEX IF NOT EXISTS api_key_account_idx ON api_key(account_id);
  `);
  await migrate(c);

  if (!REMOTE_URL) {
    try { fs.chmodSync(LOCAL_PATH, 0o600); } catch { /* not ours to change */ }
    for (const sidecar of [`${LOCAL_PATH}-wal`, `${LOCAL_PATH}-shm`]) {
      try { fs.chmodSync(sidecar, 0o600); } catch { /* may not exist */ }
    }
  }
}

/** Additive column migrations. SQLite has no IF NOT EXISTS for ADD COLUMN, so
 *  the current columns are read first. */
export async function addColumns(c: Client, table: string, columns: Record<string, string>): Promise<void> {
  const info = await c.execute(`PRAGMA table_info(${table})`);
  const have = new Set(info.rows.map((r) => r.name as string));
  for (const [name, ddl] of Object.entries(columns)) {
    if (!have.has(name)) {
      try { await c.execute(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`); }
      catch (error) {
        // Another application instance may have completed the same additive
        // migration after our PRAGMA. Ignore only that verified race.
        const current = await c.execute(`PRAGMA table_info(${table})`);
        if (!current.rows.some((r) => r.name === name)) throw error;
      }
    }
  }
}

async function migrate(c: Client): Promise<void> {
  await c.batch([
    "DELETE FROM watched_code WHERE catalogue_id IS NULL AND rowid NOT IN (SELECT MIN(rowid) FROM watched_code WHERE catalogue_id IS NULL GROUP BY account_id,digits)",
    "CREATE UNIQUE INDEX IF NOT EXISTS watched_standalone_unique ON watched_code(account_id,digits) WHERE catalogue_id IS NULL",
  ], "write");
  // Rows that predate the durable-webhook state machine (or a legacy database
  // that predates it entirely) were claimed-then-applied under the old
  // scheme, so they default to succeeded rather than being replayed.
  await addColumns(c, "webhook_event", {
    status: "TEXT NOT NULL DEFAULT 'succeeded'",
    attempts: "INTEGER NOT NULL DEFAULT 1",
    updated_at: "TEXT",
    last_error: "TEXT",
  });
  await addColumns(c, "subscription", { stripe_subscription_created: "INTEGER" });
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
    evidence_json: "TEXT",
    review_version: "INTEGER NOT NULL DEFAULT 0",
    row_number: "INTEGER",
    status: "TEXT",
    error: "TEXT",
    review_json: "TEXT",
    warnings_json: "TEXT",
    incomplete_json: "TEXT",
    // The facts a line's price actually rested on. Without these, re-pricing
    // it later against current rates would have nothing to resubmit but the
    // code, country and value — every stated quantity, preference claim or
    // Section 232 fact would silently revert to "not claimed", and the
    // resulting change would read as a rate move rather than a lost fact.
    // Rows saved before this exist have none of these; a re-price still
    // works for them, it just cannot claim what was never recorded.
    quantity: "REAL",
    quantity_unit: "TEXT",
    preference_program: "TEXT",
    end_use: "TEXT",
    metal_weight_pct: "REAL",
    vehicle_use: "TEXT",
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
    // lib/catalogues.ts reads and writes this column; without it, saving or
    // opening any catalogue fails outright (SQLITE_ERROR: no such column).
    landed_cost_json: "TEXT",
    // The two shipment-level inputs mpf and the Harbor Maintenance Fee (in
    // every line's own warnings) rest on. A re-price resubmits these, not
    // the entries=1/vessel=true the audit form happens to default to. Rows
    // saved before this exist default to that same 1/vessel, which is what
    // they were actually computed with (the audit form's own defaults).
    entries: "INTEGER NOT NULL DEFAULT 1",
    by_vessel: "INTEGER NOT NULL DEFAULT 1",
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

export type Subscription = {
  account_id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  plan: PlanId;
  status: string;
  current_period_end: string | null;
  stripe_subscription_created?: number | null;
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

const LIVE_SUBSCRIPTION_STATUSES = ["active", "trialing"];

/** The plan and limits an account's own subscription row resolves to. Shared
 *  by lib/auth.ts's currentViewer() and anything else that needs an account's
 *  real budget from just an id (lib/reprice.ts, which only ever has an
 *  accountId, not a full Viewer) -- one place decides what "live" means, not
 *  two. Lives here, not in lib/auth.ts: this file has no Next.js-runtime
 *  dependency (auth.ts imports next/headers), so anything that needs a plan
 *  resolved but isn't itself running inside a request -- reprice.ts's own
 *  lightweight tests load it directly, with no Next.js runtime at all -- can
 *  use this without pulling one in. */
export async function planFor(accountId: string): Promise<{ plan: PlanId; limits: Limits }> {
  // An unpaid, canceled or otherwise non-live subscription falls back to
  // free -- never locks someone out of what free already buys them.
  const sub = await subscriptionFor(accountId);
  const plan: PlanId = LIVE_SUBSCRIPTION_STATUSES.includes(sub.status) ? sub.plan : "free";
  return { plan, limits: PLAN_LIMITS[plan] ?? LIMITS.account };
}

export async function upsertSubscription(s: Partial<Subscription> & { account_id: string }): Promise<void> {
  const now = new Date().toISOString();
  await run(`
    INSERT INTO subscription(account_id, stripe_customer_id, stripe_subscription_id,
                             stripe_subscription_created, plan, status,
                             current_period_end, updated_at)
    VALUES(:account_id, :stripe_customer_id, :stripe_subscription_id,
           :stripe_subscription_created, :plan, :status, :current_period_end, :updated_at)
    ON CONFLICT(account_id) DO UPDATE SET
      stripe_customer_id     = COALESCE(excluded.stripe_customer_id, subscription.stripe_customer_id),
      stripe_subscription_id = excluded.stripe_subscription_id,
      stripe_subscription_created = excluded.stripe_subscription_created,
      plan                   = excluded.plan,
      status                 = excluded.status,
      current_period_end     = excluded.current_period_end,
      updated_at             = excluded.updated_at
  `, {
    account_id: s.account_id,
    stripe_customer_id: s.stripe_customer_id ?? null,
    stripe_subscription_id: s.stripe_subscription_id ?? null,
    stripe_subscription_created: s.stripe_subscription_created ?? null,
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

export type SubscriptionState = {
  stripe_subscription_id: string;
  stripe_subscription_created: number;
  plan: PlanId;
  status: string;
  current_period_end: string | null;
};

const LIVE = ["active", "trialing"];

/** Writes an authoritative Stripe subscription onto an account, unless the
 *  account already holds a different subscription that should win.
 *
 *  Stripe does not order events, so a stale event about an OLD subscription
 *  must not overwrite the one the customer is paying for now. A different
 *  subscription replaces the stored one only when it is itself active or
 *  trialing AND the stored one is not, or it was created later on Stripe's
 *  clock. The read and write share one write transaction so two concurrent
 *  deliveries cannot both pass the check.
 *
 *  Returns false when the state was ignored. */
export async function applySubscriptionState(
  accountId: string, customerId: string | null, sub: SubscriptionState,
): Promise<boolean> {
  const c = await db();
  const tx = await c.transaction("write");
  try {
    const rs = await tx.execute({
      sql: `SELECT stripe_subscription_id AS id, status, stripe_subscription_created AS created
              FROM subscription WHERE account_id = ?`,
      args: [accountId],
    });
    const cur = rs.rows[0] as unknown as
      { id: string | null; status: string; created: number | null } | undefined;
    if (cur?.id && cur.id !== sub.stripe_subscription_id) {
      const supersedes = LIVE.includes(sub.status)
        && (!LIVE.includes(cur.status) || sub.stripe_subscription_created > (cur.created ?? 0));
      if (!supersedes) {
        await tx.rollback();
        return false;
      }
    }
    await tx.execute({
      sql: `INSERT INTO subscription(account_id, stripe_customer_id, stripe_subscription_id,
                                     stripe_subscription_created, plan, status,
                                     current_period_end, updated_at)
            VALUES(?,?,?,?,?,?,?,?)
            ON CONFLICT(account_id) DO UPDATE SET
              stripe_customer_id     = COALESCE(excluded.stripe_customer_id, subscription.stripe_customer_id),
              stripe_subscription_id = excluded.stripe_subscription_id,
              stripe_subscription_created = excluded.stripe_subscription_created,
              plan                   = excluded.plan,
              status                 = excluded.status,
              current_period_end     = excluded.current_period_end,
              updated_at             = excluded.updated_at`,
      args: [accountId, customerId, sub.stripe_subscription_id, sub.stripe_subscription_created,
        sub.plan, sub.status, sub.current_period_end, new Date().toISOString()],
    });
    await tx.commit();
    return true;
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

/** Downgrades an account, but only if `subscriptionId` is the subscription it
 *  currently holds. The deletion of an old subscription is then harmless to a
 *  newer one. Returns whether anything changed. */
export async function clearSubscriptionIfCurrent(
  accountId: string, subscriptionId: string,
): Promise<boolean> {
  const rs = await run(`
    UPDATE subscription
       SET stripe_subscription_id = NULL, stripe_subscription_created = NULL,
           plan = 'free', status = 'canceled', current_period_end = NULL, updated_at = ?
     WHERE account_id = ? AND stripe_subscription_id = ?`,
    [new Date().toISOString(), accountId, subscriptionId]);
  return rs.rowsAffected > 0;
}

/** claimed: this delivery should be processed. duplicate: already applied.
 *  in_progress: another delivery is processing it right now. */
export type WebhookClaim = "claimed" | "duplicate" | "in_progress";

/** A processing claim older than this is a crashed worker, not a live one. */
const WEBHOOK_STALE_MS = 5 * 60_000;

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return /CONSTRAINT/i.test(e.code ?? "") && /unique|primary key/i.test(e.message ?? "");
}

/** Durable per-event state: processing -> succeeded | failed.
 *
 *  Only a primary-key conflict means "seen before"; any other database error
 *  propagates so the caller answers 5xx and Stripe retries, rather than a
 *  transient fault being acknowledged as a duplicate. A seen event is redone
 *  when it failed or its claim went stale, and refused while another delivery
 *  holds a fresh claim. */
export async function claimWebhookEvent(id: string, type: string): Promise<WebhookClaim> {
  const now = new Date().toISOString();
  try {
    await run(
      `INSERT INTO webhook_event(id, type, received_at, status, attempts, updated_at)
       VALUES(?, ?, ?, 'processing', 1, ?)`,
      [id, type, now, now],
    );
    return "claimed";
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }

  const stale = new Date(Date.now() - WEBHOOK_STALE_MS).toISOString();
  const res = await run(
    `UPDATE webhook_event
        SET status = 'processing', attempts = attempts + 1, updated_at = ?
      WHERE id = ? AND (status = 'failed' OR (status = 'processing' AND updated_at < ?))`,
    [now, id, stale],
  );
  if (res.rowsAffected > 0) return "claimed";

  const rs = await run("SELECT status FROM webhook_event WHERE id = ?", [id]);
  return (rs.rows[0] as unknown as { status: string } | undefined)?.status === "succeeded"
    ? "duplicate" : "in_progress";
}

export type ApiKey = {
  id: string; account_id: string; name: string; prefix: string; hash: string;
  created_at: string; last_used_at: string | null; revoked_at: string | null;
};

export async function insertApiKey(row: {
  id: string; account_id: string; name: string; prefix: string; hash: string; created_at: string;
}): Promise<void> {
  await run(
    "INSERT INTO api_key(id, account_id, name, prefix, hash, created_at) VALUES(?,?,?,?,?,?)",
    [row.id, row.account_id, row.name, row.prefix, row.hash, row.created_at],
  );
}

export async function apiKeyByHash(hash: string): Promise<ApiKey | undefined> {
  const rs = await run("SELECT * FROM api_key WHERE hash = ?", [hash]);
  return rs.rows[0] as unknown as ApiKey | undefined;
}

export async function apiKeysForAccount(accountId: string): Promise<ApiKey[]> {
  const rs = await run(
    "SELECT * FROM api_key WHERE account_id = ? ORDER BY created_at DESC", [accountId],
  );
  return rs.rows as unknown as ApiKey[];
}

const LAST_USED_STALE_MS = 5 * 60_000;

/** Best-effort, and deliberately coarse: writing this on every authenticated
 *  request would mean one write per API call. A key's last-used time only
 *  needs to be accurate to within a few minutes for support/debugging. */
export async function touchApiKeyLastUsed(id: string, lastKnown: string | null): Promise<void> {
  if (lastKnown && Date.now() - new Date(lastKnown).getTime() < LAST_USED_STALE_MS) return;
  await run("UPDATE api_key SET last_used_at = ? WHERE id = ?", [new Date().toISOString(), id]);
}

/** Revocation, not deletion: a revoked key's `last_used_at` and creation date
 *  stay visible for support/debugging. Scoped to the account so one customer
 *  cannot revoke another's key by guessing an id. Returns whether a row
 *  actually matched. */
export async function revokeApiKeyRow(accountId: string, id: string): Promise<boolean> {
  const res = await run(
    "UPDATE api_key SET revoked_at = ? WHERE id = ? AND account_id = ? AND revoked_at IS NULL",
    [new Date().toISOString(), id, accountId],
  );
  return res.rowsAffected > 0;
}

export async function finishWebhookEvent(id: string, error?: string): Promise<void> {
  await run(
    "UPDATE webhook_event SET status = ?, last_error = ?, updated_at = ? WHERE id = ?",
    [error === undefined ? "succeeded" : "failed", error ?? null, new Date().toISOString(), id],
  );
}
