import Database from "better-sqlite3";
import path from "node:path";
import type { PlanId } from "./plans";

/** Account store.
 *
 *  Separate from the reference database, which is read-only and rebuilt from
 *  public sources. This one is the only thing we cannot regenerate, so it
 *  lives on its own file and is the only thing that needs backing up.
 */
const DB_PATH = process.env.HTSDESK_ACCOUNTS_DB
  ?? path.join(process.cwd(), "..", "data", "accounts.db");

let _db: Database.Database | null = null;

export function db(): Database.Database {
  if (_db) return _db;
  const d = new Database(DB_PATH);
  d.pragma("journal_mode = WAL");
  d.pragma("busy_timeout = 5000");
  d.exec(`
    CREATE TABLE IF NOT EXISTS account (
      id            TEXT PRIMARY KEY,
      email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      created_at    TEXT NOT NULL
    );

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

    -- Webhook ids we have already applied. Stripe retries and can deliver the
    -- same event more than once; without this a retry could downgrade an
    -- account that has since upgraded.
    CREATE TABLE IF NOT EXISTS webhook_event (
      id          TEXT PRIMARY KEY,
      type        TEXT,
      received_at TEXT NOT NULL
    );
  `);
  _db = d;
  return d;
}

export type Account = { id: string; email: string; created_at: string };
export type Subscription = {
  account_id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  plan: PlanId;
  status: string;
  current_period_end: string | null;
};

export function accountByEmail(email: string) {
  return db().prepare("SELECT * FROM account WHERE email = ?").get(email) as
    (Account & { password_hash: string }) | undefined;
}

export function accountById(id: string) {
  return db().prepare("SELECT id, email, created_at FROM account WHERE id = ?").get(id) as
    Account | undefined;
}

export function createAccount(id: string, email: string, passwordHash: string) {
  const now = new Date().toISOString();
  const tx = db().transaction(() => {
    db().prepare(
      "INSERT INTO account(id, email, password_hash, created_at) VALUES(?, ?, ?, ?)"
    ).run(id, email, passwordHash, now);
    db().prepare(
      "INSERT INTO subscription(account_id, plan, status, updated_at) VALUES(?, 'free', 'active', ?)"
    ).run(id, now);
  });
  tx();
}

export function subscriptionFor(accountId: string): Subscription {
  const row = db().prepare("SELECT * FROM subscription WHERE account_id = ?")
    .get(accountId) as Subscription | undefined;
  return row ?? {
    account_id: accountId, stripe_customer_id: null, stripe_subscription_id: null,
    plan: "free", status: "active", current_period_end: null,
  };
}

export function upsertSubscription(s: Partial<Subscription> & { account_id: string }) {
  const now = new Date().toISOString();
  db().prepare(`
    INSERT INTO subscription(account_id, stripe_customer_id, stripe_subscription_id,
                             plan, status, current_period_end, updated_at)
    VALUES(@account_id, @stripe_customer_id, @stripe_subscription_id,
           @plan, @status, @current_period_end, @updated_at)
    ON CONFLICT(account_id) DO UPDATE SET
      stripe_customer_id     = COALESCE(excluded.stripe_customer_id, subscription.stripe_customer_id),
      stripe_subscription_id = excluded.stripe_subscription_id,
      plan                   = excluded.plan,
      status                 = excluded.status,
      current_period_end     = excluded.current_period_end,
      updated_at             = excluded.updated_at
  `).run({
    account_id: s.account_id,
    stripe_customer_id: s.stripe_customer_id ?? null,
    stripe_subscription_id: s.stripe_subscription_id ?? null,
    plan: s.plan ?? "free",
    status: s.status ?? "active",
    current_period_end: s.current_period_end ?? null,
    updated_at: now,
  });
}

export function accountForCustomer(customerId: string): string | null {
  const row = db().prepare(
    "SELECT account_id FROM subscription WHERE stripe_customer_id = ?"
  ).get(customerId) as { account_id: string } | undefined;
  return row?.account_id ?? null;
}

/** True the first time an event id is seen; false on a redelivery. */
export function claimWebhookEvent(id: string, type: string): boolean {
  try {
    db().prepare(
      "INSERT INTO webhook_event(id, type, received_at) VALUES(?, ?, ?)"
    ).run(id, type, new Date().toISOString());
    return true;
  } catch {
    return false;
  }
}
