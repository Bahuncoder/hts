/** Accessibility, console and layout checks across every route at desktop and
 *  phone width, using the axe-core already in node_modules. Fails on any
 *  violation, console error, sideways overflow or failed route.
 *  Run: node tests/a11y.test.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { chromium } from "playwright-core";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3502, BASE = `http://127.0.0.1:${PORT}`;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "htsdesk-audit-"));
const dbPath = path.join(scratch, "accounts.db");
const AXE = path.join(WEB, "node_modules/axe-core/axe.min.js");

const child = spawn(process.execPath, [path.join(WEB, "node_modules/next/dist/bin/next"), "dev", "-p", String(PORT), "-H", "127.0.0.1"], {
  cwd: WEB, env: { PATH: process.env.PATH, HOME: process.env.HOME, NEXT_TELEMETRY_DISABLED: "1",
    HTSDESK_ACCOUNTS_DB: dbPath, HTSDESK_ADMIN_TOKEN: "admin-test-token", HTSDESK_EMAIL_SECRET: "test-email-secret", SITE_URL: BASE,
    HTSDESK_API: "http://127.0.0.1:8099" },
});
let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
let browser;
const report = [];
try {
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(log);
    try { if ((await fetch(`${BASE}/robots.txt`)).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error("no server\n" + log);
    await new Promise((r) => setTimeout(r, 250));
  }
  const db = createClient({ url: `file:${dbPath}` });
  await fetch(`${BASE}/api/admin/diff`, { headers: { "x-admin-token": "admin-test-token" } });
  const now = new Date().toISOString();
  await db.execute({ sql: "INSERT INTO account(id,email,password_hash,created_at,alert_emails) VALUES(?,?,?,?,1)", args: ["owner", "owner@example.test", "scrypt$0$0", now] });
  await db.execute({ sql: "INSERT INTO session VALUES(?,?,?)", args: ["owner-session", "owner", "2099-01-01T00:00:00.000Z"] });
  await db.execute({ sql: "INSERT INTO catalogue(id,account_id,name,created_at,updated_at,totals_complete,mpf,entries,by_vessel) VALUES(?,?,?,?,?,?,?,?,?)", args: ["cat", "owner", "Spring import", now, now, 0, 0, 1, 1] });
  await fetch(`${BASE}/catalogues/cat/review`, { headers: { cookie: "htsdesk_session=owner-session" } });
  const rows = [
    ["item1", 1, "TS-001", "mens knitted cotton t-shirt", "China", 48000, "6109.10.00.12", "ready", "approved"],
    ["item2", 2, "MG-09", "ceramic coffee mug", "Germany", 12000, null, "unclassified", "pending"],
  ];
  for (const [id, n, sku, desc, country, value, hts, status, approval] of rows) {
    await db.execute({ sql: `INSERT INTO catalogue_item(id,catalogue_id,sku,description,country,value,hts,digits,status,row_number,duty,approval_status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [id, "cat", sku, desc, country, value, hts, hts ? hts.replace(/\./g, "") : null, status, n, hts ? value * 0.1 : null, approval] });
  }

  browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  const routes = [
    ["/", false], ["/classify", false], ["/classify?q=cotton%20knit%20shirt", false], ["/calculator", false],
    ["/calculator?hts=6912.00.44.00&country=China&value=12000", false], ["/audit", false], ["/pricing", false],
    ["/china-tariffs", false], ["/changes", false], ["/login", false], ["/signup", false], ["/privacy", false],
    ["/terms", false], ["/hts/6109.10.00.12", false], ["/catalogues", true], ["/catalogues/cat", true],
    ["/catalogues/cat/review", true], ["/catalogues/cat/review?item=item2", true], ["/account", true],
    ["/alerts", true], ["/refund-check", true],
  ];
  for (const [route, signedIn] of routes) {
    for (const [vname, vp] of [["desktop", { width: 1280, height: 900 }], ["phone", { width: 390, height: 844 }]]) {
      const ctx = await browser.newContext({ viewport: vp });
      if (signedIn) await ctx.addCookies([{ name: "htsdesk_session", value: "owner-session", domain: "127.0.0.1", path: "/" }]);
      const page = await ctx.newPage();
      const consoleErrors = [];
      page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 160)); });
      page.on("pageerror", (e) => consoleErrors.push("pageerror: " + String(e).slice(0, 160)));
      let status = 0;
      try {
        const resp = await page.goto(BASE + route, { waitUntil: "networkidle", timeout: 60000 });
        status = resp ? resp.status() : 0;
        await page.addScriptTag({ path: AXE });
        const axe = await page.evaluate(async () => {
          const r = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "best-practice"] } });
          return r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, help: v.help }));
        });
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        report.push({ route, view: vname, status, overflowPx: overflow, violations: axe, consoleErrors: consoleErrors.slice(0, 3) });
      } catch (e) {
        report.push({ route, view: vname, status, error: String(e).slice(0, 200) });
      }
      await ctx.close();
    }
  }
  fs.writeFileSync(path.join(scratch, "report.json"), JSON.stringify(report, null, 2));
  let failures = 0;
  for (const r of report) {
    const v = (r.violations || []).map((x) => `${x.impact}:${x.id}(${x.nodes})`).join(" ");
    const bad = r.error || (r.violations || []).length || (r.overflowPx ?? 0) > 0 || (r.consoleErrors || []).length;
    if (bad) failures += 1;
    console.log(`${bad ? "FAIL" : "ok  "} ${r.route.padEnd(48)} ${r.view.padEnd(8)} ${String(r.status).padEnd(4)} overflow=${r.overflowPx ?? "-"} errs=${(r.consoleErrors || []).length} ${r.error ? "ERROR " + r.error.slice(0, 80) : v}`);
  }
  console.log(`\n${report.length - failures}/${report.length} route checks passed`);
  process.exitCode = failures ? 1 : 0;
} finally {
  if (browser) await browser.close();
  child.kill("SIGTERM");
  fs.rmSync(scratch, { recursive: true, force: true });
}
