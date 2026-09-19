/** Shared plumbing for the integration tests that drive the real app.
 *
 *  Each test starts the PRODUCTION build (`next start`) on a spare port with
 *  its own accounts database, and talks to it over HTTP, with small fake
 *  servers standing in for Stripe, the engine API and the mail provider. So
 *  what is exercised is the shipped route handlers and library code, not a
 *  copy of them.
 *
 *  Safety: an accounts database is only ever created fresh, in a scratch
 *  directory. Pointing a test at an existing file requires
 *  HTSDESK_TEST_ALLOW_EXISTING_DB=1, because these tests write to it.
 *  Ports 3000 and 8099 belong to the developer's own servers and are refused.
 */
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ADMIN_TOKEN = "admin-test-token";
export const EMAIL_SECRET = "test-email-secret";

const scratchDirs = [];
const children = new Set();
const servers = new Set();

function cleanup() {
  for (const child of children) { try { child.kill("SIGKILL"); } catch { /* gone */ } }
  for (const s of servers) { try { s.closeAllConnections?.(); s.close(); } catch { /* gone */ } }
  for (const d of scratchDirs) fs.rmSync(d, { recursive: true, force: true });
}
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));

export function scratchDir(prefix = "htsdesk-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

let dbPath;
/** One accounts database per test process, fresh by construction. */
export function freshDbPath() {
  if (dbPath) return dbPath;
  const explicit = process.env.HTSDESK_ACCOUNTS_DB;
  if (explicit) {
    if (fs.existsSync(explicit) && process.env.HTSDESK_TEST_ALLOW_EXISTING_DB !== "1") {
      throw new Error(
        `refusing to run against existing database ${explicit}; these tests write to it. ` +
        "Unset HTSDESK_ACCOUNTS_DB to use a scratch database, or set " +
        "HTSDESK_TEST_ALLOW_EXISTING_DB=1 if you really mean it.");
    }
    return (dbPath = explicit);
  }
  return (dbPath = path.join(scratchDir(), "accounts.db"));
}

// Decided at import, before any server or fake is started.
freshDbPath();

export function suite() {
  const results = [];
  return {
    async check(name, fn) {
      try { await fn(); results.push([name, null]); }
      catch (e) { results.push([name, e.stack ?? e.message]); }
    },
    finish() {
      const failed = results.filter(([, e]) => e);
      const w = Math.max(...results.map(([n]) => n.length));
      for (const [name, err] of results) {
        console.log(`  ${err ? "FAIL" : "ok  "}  ${name.padEnd(w)}`);
        if (err) console.log(`        ${err.split("\n").slice(0, 4).join("\n        ").slice(0, 600)}`);
      }
      console.log(`\n${results.length - failed.length}/${results.length} passed`);
      return failed.length ? 1 : 0;
    },
  };
}

function newestSource() {
  let newest = 0;
  const walk = (p) => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, e.name);
      if (e.isDirectory()) walk(full);
      else newest = Math.max(newest, fs.statSync(full).mtimeMs);
    }
  };
  walk(path.join(WEB, "src"));
  for (const f of ["package.json", "next.config.ts"]) newest = Math.max(newest, fs.statSync(path.join(WEB, f)).mtimeMs);
  return newest;
}

/** The tests are only meaningful against the code as it is now. Rebuilds
 *  (from clean, like `make build`) when the build is missing or older than
 *  any source file. */
export function ensureBuild() {
  let built = 0;
  try { built = fs.statSync(path.join(WEB, ".next", "BUILD_ID")).mtimeMs; } catch { /* none */ }
  if (built > newestSource()) return;
  console.log("building the production bundle...");
  fs.rmSync(path.join(WEB, ".next"), { recursive: true, force: true });
  // The build must not open (and so create) a real accounts database.
  execSync("npm run build", {
    cwd: WEB, stdio: "inherit",
    env: { ...process.env, HTSDESK_ACCOUNTS_DB: path.join(scratchDir(), "build.db"),
           TURSO_DATABASE_URL: "" },
  });
}

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    s.once("connect", () => { s.destroy(); resolve(false); });
    s.once("error", () => resolve(true));
  });
}

function assertSparePort(port) {
  if (port === 3000 || port === 8099) throw new Error(`port ${port} is reserved`);
}

/** `dbFile` lets a test prepare its own database (e.g. a legacy schema), but
 *  only one it created inside a scratch directory. */
export async function startApp({ port, env = {}, dbFile }) {
  assertSparePort(port);
  if (!(await portFree(port))) throw new Error(`port ${port} is already in use`);
  ensureBuild();
  if (dbFile && !scratchDirs.some((d) => path.resolve(dbFile).startsWith(d + path.sep))) {
    throw new Error(`${dbFile} is not inside a scratch directory`);
  }
  const db = dbFile ?? freshDbPath();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath,
    [path.join(WEB, "node_modules/next/dist/bin/next"), "start", "-p", String(port), "-H", "127.0.0.1"], {
      cwd: WEB,
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "production",
        NEXT_TELEMETRY_DISABLED: "1",
        HTSDESK_ACCOUNTS_DB: db,
        HTSDESK_ADMIN_TOKEN: ADMIN_TOKEN,
        HTSDESK_EMAIL_SECRET: EMAIL_SECRET,
        ...env,
      },
    });
  children.add(child);
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const exited = new Promise((r) => child.once("exit", r));

  const deadline = Date.now() + 40_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${log}`);
    try { if ((await fetch(`${base}/robots.txt`)).ok) break; } catch { /* not yet */ }
    if (Date.now() > deadline) { child.kill("SIGKILL"); throw new Error(`server did not start:\n${log}`); }
    await new Promise((r) => setTimeout(r, 250));
  }
  // Touching the store creates the schema, so tests can seed rows afterwards.
  await fetch(`${base}/api/admin/diff`, { headers: { "x-admin-token": ADMIN_TOKEN } });

  const app = {
    base, log: () => log, dbPath: db,
    /** A second connection to the app's own scratch database. */
    db: () => createClient({ url: `file:${db}` }),
    async stop() {
      child.kill("SIGTERM");
      const t = setTimeout(() => child.kill("SIGKILL"), 5000);
      await exited;
      clearTimeout(t);
      children.delete(child);
    },
    admin: (pathAndQuery, init = {}) => fetch(`${base}${pathAndQuery}`, {
      method: "POST", ...init, headers: { "x-admin-token": ADMIN_TOKEN, ...init.headers },
    }),
  };
  return app;
}

export async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

export async function fakeServer(port, handler) {
  assertSparePort(port);
  const server = http.createServer(async (req, res) => {
    try { await handler(req, res); }
    catch (e) { res.writeHead(500); res.end(String(e)); }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  servers.add(server);
  return {
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      servers.delete(server);
    },
  };
}

export const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

/** A stand-in engine API. /api/changes follows the contract of the real one:
 *  `since` inclusive, `cursor` continues strictly after a "date|document"
 *  position, oldest first ordered by (publication_date, document_number),
 *  `has_more` when a page came back full. */
export async function fakeEngine(port) {
  const state = {
    docs: [], changesCalls: [], changesKeys: [], failChangesAt: null, auditCalls: 0, auditStatus: 200,
    auditKeys: [], classifyCalls: 0,
  };
  const server = await fakeServer(port, async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/api/changes") {
      state.changesCalls.push(Object.fromEntries(url.searchParams));
      state.changesKeys.push(req.headers["x-api-key"]);
      if (state.failChangesAt === state.changesCalls.length) return json(res, 500, { detail: "boom" });
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const cursor = url.searchParams.get("cursor");
      const since = url.searchParams.get("since");
      const key = (d) => `${d.publication_date}|${d.document_number}`;
      let rows = [...state.docs].sort((a, b) => (key(a) < key(b) ? -1 : 1));
      if (cursor) rows = rows.filter((d) => key(d) > cursor);
      else if (since) rows = rows.filter((d) => d.publication_date >= since);
      const out = rows.slice(0, limit);
      return json(res, 200, {
        days: 90, count: out.length, has_more: out.length === limit,
        next_cursor: out.length ? key(out.at(-1)) : null, changes: out,
      });
    }
    if (url.pathname === "/api/audit" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      state.auditCalls += 1;
      state.auditKeys.push(req.headers["x-api-key"]);
      if (body.items.some((i) => i.description === "slow")) await new Promise((r) => setTimeout(r, 900));
      return json(res, state.auditStatus, { ok: state.auditStatus < 400, submitted: body.items.length });
    }
    if (url.pathname === "/api/classify") {
      state.classifyCalls += 1;
      return json(res, 200, { query: url.searchParams.get("q"), candidates: [], reasoned: false, notes: [] });
    }
    return json(res, 404, { detail: "not found" });
  });
  return { state, close: server.close };
}

export async function seedAccount(db, { id, plan = "free", status = "active", alertEmails = 1,
                                        customer = null, subscription = null }) {
  const now = new Date().toISOString();
  await db.execute({
    sql: "INSERT INTO account(id,email,password_hash,created_at,alert_emails) VALUES(?,?,?,?,?)",
    args: [id, `${id}@example.test`, "scrypt$0$0", now, alertEmails],
  });
  await db.execute({
    sql: `INSERT INTO subscription(account_id,stripe_customer_id,stripe_subscription_id,plan,status,updated_at)
          VALUES(?,?,?,?,?,?)`,
    args: [id, customer, subscription, plan, status, now],
  });
}
