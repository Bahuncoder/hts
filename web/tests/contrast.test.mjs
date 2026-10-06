import { sessionTokenHash } from "./sessionfixture.mjs";
/** Measured WCAG contrast of the text the pages actually render, in light and
 *  dark, in a real browser against the production build.
 *
 *  Nothing here is a table of colours. For each page state the browser is asked
 *  for the computed foreground of every visible piece of text and the effective
 *  background behind it (background colours composited up the ancestor chain,
 *  opacity applied), and the WCAG 2.x ratio is computed from those. Every ratio
 *  must be >= 4.5, or >= 3.0 for large text (>= 24px, or >= 18.66px at weight
 *  700). Disabled controls are exempt, as WCAG allows.
 *
 *  Each state is measured in four modes, and each mode is first verified to be
 *  the mode it claims (the --paper token is read back), so a broken switch
 *  cannot pass vacuously:
 *    light           system light, no data-theme
 *    system-dark     system dark, no data-theme      (the media query)
 *    explicit-dark   system light, data-theme=dark
 *    explicit-light  system dark,  data-theme=light
 *
 *  A named list of selectors per page must each match at least one measured
 *  piece of text, so the sweep cannot quietly stop covering what matters.
 *
 *  Production build on 3361, a fake engine on 3362, a scratch accounts database.
 *  Run: node tests/contrast.test.mjs   (with HTSDESK_ACCOUNTS_DB unset)
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { chromium } from "playwright-core";
import { fakeServer, json, readBody, seedAccount, startApp, suite } from "./harness.mjs";
import { auditResponse } from "./auditfixture.mjs";
import { HEALTH_WITH_COUNTS, htsFixture, quoteFixture } from "./enginefixture.mjs";

const fake = await fakeServer(3362, async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/api/health") return json(res, 200, HEALTH_WITH_COUNTS);
  if (url.pathname === "/api/audit") return json(res, 200, auditResponse(JSON.parse(await readBody(req))));
  if (url.pathname.startsWith("/api/hts/")) {
    return json(res, 200, htsFixture(decodeURIComponent(url.pathname.split("/").pop()), url.searchParams.get("country") ?? "China"));
  }
  if (url.pathname === "/api/quote") {
    const b = JSON.parse(await readBody(req));
    return json(res, 200, quoteFixture({ hts: b.hts, country: b.country, value: b.value }));
  }
  if (url.pathname === "/api/search") return json(res, 200, { query: "", results: [] });
  return json(res, 404, { detail: "not found" });
});
const app = await startApp({
  port: 3361,
  env: { HTSDESK_API: "http://127.0.0.1:3362", HTSDESK_API_KEY: "k", HTSDESK_SIGNING_SECRET: "test-signing" },
});
const db = app.db();
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const { check, finish } = suite();

await seedAccount(db, { id: "contrast" });
const token = crypto.randomBytes(16).toString("hex");
await db.execute({ sql: "INSERT INTO session(token, account_id, expires_at) VALUES(?,?,?)",
  args: [sessionTokenHash(token), "contrast", new Date(Date.now() + 3_600_000).toISOString()] });
await db.execute({ sql: `INSERT INTO alert(id,account_id,document_number,title,publication_date,html_url,digits,hts,created_at,email_status,emailed_at,email_attempts)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
  args: [crypto.randomUUID(), "contrast", "2026-0001", "Notice naming a watched code", "2026-08-10",
    "https://www.federalregister.gov/d/2026-0001", "6109100012", "6109.10.00.12", new Date().toISOString(),
    "failed_permanent", new Date().toISOString(), 5] });

const MODES = [
  { name: "light", scheme: "light", theme: null, paper: "rgb(250, 249, 246)" },
  { name: "system-dark", scheme: "dark", theme: null, paper: "rgb(14, 21, 19)" },
  { name: "explicit-dark", scheme: "light", theme: "dark", paper: "rgb(14, 21, 19)" },
  { name: "explicit-light", scheme: "dark", theme: "light", paper: "rgb(250, 249, 246)" },
];

/** Runs in the page. Returns { measured, failures, min, missing }. */
function sweep({ named }) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const g = canvas.getContext("2d", { willReadFrequently: true });
  const rgba = (css) => {
    g.clearRect(0, 0, 1, 1);
    g.fillStyle = "#000";
    g.fillStyle = css; // the canvas resolves any CSS colour syntax
    g.fillRect(0, 0, 1, 1);
    const [r, gr, b, a] = g.getImageData(0, 0, 1, 1).data;
    return { r, g: gr, b, a: a / 255 };
  };
  const over = (top, bottom) => {
    const a = top.a + bottom.a * (1 - top.a);
    if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
    const mix = (t, b2) => (t * top.a + b2 * bottom.a * (1 - top.a)) / a;
    return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a };
  };
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

  const describe = (el) => {
    const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/).slice(0, 3).join(".") : "";
    return `${el.tagName.toLowerCase()}${cls ? "." + cls : ""}`;
  };

  /** Effective background: every ancestor's background composited, root first. */
  function backgroundOf(el) {
    const chain = [];
    for (let e = el; e; e = e.parentElement) chain.unshift(e);
    let bg = { r: 255, g: 255, b: 255, a: 1 }; // the browser canvas
    for (const e of chain) {
      const cs = getComputedStyle(e);
      if (cs.backgroundImage !== "none") return null; // not measurable as a flat colour
      const c = rgba(cs.backgroundColor);
      if (c.a > 0) bg = over(c, bg);
    }
    return bg;
  }
  const opacityOf = (el) => {
    let o = 1;
    for (let e = el; e; e = e.parentElement) o *= parseFloat(getComputedStyle(e).opacity);
    return o;
  };

  function measure(el, pseudo) {
    const cs = getComputedStyle(el, pseudo);
    const bg = backgroundOf(el);
    if (!bg) return { skipped: true };
    let fg = rgba(cs.color);
    fg = { ...fg, a: fg.a * opacityOf(el) };
    const flat = over(fg, bg);
    const size = parseFloat(cs.fontSize);
    const weight = parseInt(cs.fontWeight, 10) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const need = large ? 3 : 4.5;
    const r = ratio(flat, bg);
    const text = (el.value || el.getAttribute("placeholder") || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
    return { el: describe(el) + (pseudo ?? ""), text, r, need, size, ok: r >= need,
      fg: `rgb(${Math.round(flat.r)},${Math.round(flat.g)},${Math.round(flat.b)})`,
      bg: `rgb(${Math.round(bg.r)},${Math.round(bg.g)},${Math.round(bg.b)})` };
  }

  const visible = (el) => {
    if (!el.checkVisibility({ visibilityProperty: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "OPTION", "OPTGROUP", "TITLE"]);
  const hasOwnText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
  const exempt = (el) => Boolean(el.closest(":disabled, [aria-disabled='true']"));

  /** The measurements for one element: its own text, and a placeholder. */
  function measureElement(el) {
    const out = [];
    if (SKIP.has(el.tagName) || el instanceof SVGElement || exempt(el) || !visible(el)) return out;
    const control = el.matches("input, textarea, select");
    if (control && el.tagName !== "SELECT" && el.type !== "hidden" && el.type !== "checkbox" && el.type !== "radio" && el.type !== "file") {
      if (el.value) out.push(measure(el));
      else if (el.getAttribute("placeholder")) out.push(measure(el, "::placeholder"));
    } else if (control && el.tagName === "SELECT") {
      out.push(measure(el));
    } else if (hasOwnText(el)) {
      out.push(measure(el));
    }
    return out;
  }

  const all = [...document.body.querySelectorAll("*")].flatMap(measureElement);
  const skipped = all.filter((m) => m.skipped).length;
  const measured = all.filter((m) => !m.skipped);
  const failures = measured.filter((m) => !m.ok);

  const missing = [];
  for (const sel of named) {
    const els = [...document.querySelectorAll(sel)];
    const ms = els.flatMap((el) => [el, ...el.querySelectorAll("*")].flatMap(measureElement)).filter((m) => !m.skipped);
    if (!ms.length) missing.push(sel);
  }
  return {
    measured: measured.length, skipped, failures,
    min: measured.length ? Math.min(...measured.map((m) => m.r)) : null,
    paper: getComputedStyle(document.documentElement).getPropertyValue("--paper").trim(),
    paperBg: getComputedStyle(document.body).backgroundColor,
    missing,
  };
}

const summary = [];

/** Measures the current page in every mode. */
async function inAllModes(page, label, named) {
  await page.emulateMedia({ reducedMotion: "reduce" }); // no colour transitions mid-measure
  const problems = [];
  for (const mode of MODES) {
    await page.emulateMedia({ colorScheme: mode.scheme, reducedMotion: "reduce" });
    await page.evaluate((theme) => {
      if (theme) document.documentElement.dataset.theme = theme;
      else delete document.documentElement.dataset.theme;
    }, mode.theme);
    const r = await page.evaluate(sweep, { named });
    assert.equal(r.paperBg, mode.paper, `${label}: the ${mode.name} mode did not take effect (body background ${r.paperBg})`);
    assert.ok(r.measured >= 8, `${label} [${mode.name}]: only ${r.measured} pieces of text measured`);
    if (r.missing.length) problems.push(`[${mode.name}] no measured text matched: ${r.missing.join(", ")}`);
    for (const f of r.failures) {
      problems.push(`[${mode.name}] ${f.r.toFixed(2)}:1 < ${f.need}  ${f.el} "${f.text}" ${f.fg} on ${f.bg} (${f.size}px)`);
    }
    summary.push({ label, mode: mode.name, measured: r.measured, min: r.min });
  }
  assert.deepEqual(problems, [], `${label}:\n  ${problems.slice(0, 12).join("\n  ")}${problems.length > 12 ? `\n  ... and ${problems.length - 12} more` : ""}`);
}

const go = (page, path) => page.goto(`${app.base}${path}`, { waitUntil: "networkidle" });
const MIXED = [
  "sku,description,country,value,hts",
  "A-1,ready shirt,China,1000,",
  "A-2,scope shirt,China,2000,",
  "A-3,suffix mug,Germany,300,",
  "A-4,lowconf bag,China,400,",
  "A-5,incomplete thing,China,500,",
  "A-6,noclass,China,600,",
  "A-7,bad amount,China,abc,",
].join("\n");

async function newPage(signedIn) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  if (signedIn) await ctx.addCookies([{ name: "htsdesk_session", value: token, url: app.base }]);
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  return { ctx, page };
}

try {
  const anon = await newPage(false);
  const user = await newPage(true);
  const p = anon.page;

  await check("/ : hero, beta pill, cards, evidence, footer and its legal disclaimer", async () => {
    await go(p, "/");
    await inAllModes(p, "/", [".eyebrow", ".hero-title", ".hero a.btn", ".hero .rounded-full", ".hero-example .lbl",
      ".hero-example .mono", ".tool-card", "dl dt", "dl dd", "footer p", "footer a"]);
  });

  await check("/audit : the empty import form (placeholder, helper text, labels)", async () => {
    await go(p, "/audit");
    await inAllModes(p, "/audit (empty)", [".page-header .eyebrow", ".page-description", "#catalogue-text", ".workflow-step", ".panel-title",
      ".btn-secondary", "summary", "footer p"]);
  });

  await check("/audit : sample warning and a header problem", async () => {
    await go(p, "/audit");
    await p.getByRole("button", { name: "Try a sample" }).click();
    await inAllModes(p, "/audit (sample)", ["#catalogue-preflight p", ".text-caution-ink"]);
    await p.fill("textarea", "sku,description,value\nA,shirt,10");
    await inAllModes(p, "/audit (problem)", ["#catalogue-preflight .text-danger", "#catalogue-preflight li"]);
  });

  await check("/audit : results with every status, open details, and the anonymous save note", async () => {
    await go(p, "/audit");
    await db.execute("DELETE FROM usage_event");
    await p.fill("textarea", MIXED);
    await p.getByRole("button", { name: "Run audit", exact: true }).click();
    await p.locator('[data-testid="reconciliation"]').waitFor({ timeout: 20000 });
    // Each click turns a "Details" button into "Hide details", so the first match moves on.
    for (let i = 0; i < 5; i++) await p.getByRole("button", { name: /^Details/ }).first().click();
    await inAllModes(p, "/audit (results)", ['[data-testid="import-summary"]', '[data-testid="reconciliation"]', ".metric-card", ".data-table th",
      ".data-table td", ".text-recover", "tr.bg-sunk", ".rounded.border", "footer p", "a.text-accent"]);
  });

  await check("/audit and /account : signed in, with the unsaved-catalogue notice", async () => {
    const q = user.page;
    await go(q, "/audit");
    await q.evaluate(() => localStorage.setItem("htsdesk.draft.v1", JSON.stringify({
      text: "sku,description,country,value\nA,shirt,China,10", entries: 1, transport: "vessel", savedAt: Date.now() - 600_000, rows: 1 })));
    await q.reload({ waitUntil: "networkidle" });
    await q.getByTestId("draft-notice").waitFor();
    await inAllModes(q, "/audit (draft notice)", ['[data-testid="draft-notice"]', '[data-testid="draft-notice"] .btn-primary', '[data-testid="draft-notice"] .btn-secondary']);
    await go(q, "/account#plan");
    await q.getByTestId("draft-notice").waitFor();
    await inAllModes(q, "/account#plan", ['[data-testid="draft-notice"]', ".settings-label", ".settings-limits dt", "h2", "footer p"]);
    await q.evaluate(() => localStorage.removeItem("htsdesk.draft.v1"));
  });

  await check("/alerts : status block with undelivered emails", async () => {
    await go(user.page, "/alerts");
    await inAllModes(user.page, "/alerts", ['[data-testid="monitoring-status"]', '[data-testid="monitoring-status"] p', "a.text-accent"]);
  });

  await check("/hts/6109.10.00.12 : title, path, incomplete estimate, recovery, remedies (open)", async () => {
    await go(p, "/hts/6109.10.00.12");
    await p.getByTestId("other-remedies").locator("summary").click();
    await inAllModes(p, "/hts", ['[data-testid="hts-title"]', '[data-testid="hts-path"]', ".lbl", '.mono[style*="--recover"]', '.mono[style*="--caution"]', ".text-caution",
      "thead th", "td", "summary", "footer p", "footer a"]);
  });

  await check("/calculator : the form, then a scenario result", async () => {
    await go(p, "/calculator");
    await inAllModes(p, "/calculator", [".page-description", "label", ".field-control", ".btn-primary", "footer p"]);
    await go(p, "/calculator?hts=6109.10.00.12&country=China&value=10000");
    await inAllModes(p, "/calculator (result)", [".lbl", ".mono", ".text-caution", "footer p"]);
  });

  await check("/login and /signup : form, helper text, links and notices", async () => {
    await go(p, "/login");
    await p.fill("input[name=email]", "someone@example.test");
    await inAllModes(p, "/login", [".eyebrow", "h1", ".lbl", "input[name=email]", ".btn-primary", "a.text-accent", "footer p"]);
    await go(p, "/signup?verify=expired");
    await inAllModes(p, "/signup", [".text-caution-ink", ".lbl", "span.text-faint", "footer p"]);
  });

  await check("the detector itself: the previous --faint (#6b7a75) is caught on the same page", async () => {
    await go(p, "/audit");
    const style = await p.addStyleTag({ content: ":root, :root[data-theme] { --faint: #6b7a75 !important; }" });
    await p.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    const r = await p.evaluate(sweep, { named: [] });
    assert.ok(r.failures.some((f) => f.r < 4.5 && f.fg === "rgb(107,122,117)"),
      `expected the old faint to fail somewhere; failures: ${JSON.stringify(r.failures.slice(0, 3))}`);
    await style.evaluate((el) => el.remove());
    assert.equal((await p.evaluate(sweep, { named: [] })).failures.length, 0);
  });

  await check("the contrast floor is reported", () => {
    const worst = summary.reduce((a, b) => (a.min !== null && a.min <= b.min ? a : b));
    console.log(`        ${summary.length} page-state x mode sweeps, ${summary.reduce((n, s) => n + s.measured, 0)} text measurements; ` +
      `lowest ratio ${worst.min.toFixed(2)}:1 (${worst.label}, ${worst.mode})`);
    assert.ok(worst.min >= 3, "sanity: nothing far below the large-text floor");
  });
} finally {
  await browser.close().catch(() => {});
  db.close();
  await app.stop().catch(() => {});
  await fake.close();
}
process.exit(finish());
