"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { saveCatalogueAction } from "@/lib/actions";
import { AUDIT_COLUMNS, auditExportRow, toCsv } from "@/lib/csv";
import { projectLine, type AuditLine } from "@/lib/auditModel";
import { LIMITS } from "@/lib/plans";
import { DraftNotice, useSavedDraft } from "@/components/DraftNotice";
import { clearDraft, countRows, writeDraft } from "@/lib/draft";
import { EXPECTED_FORMAT, SAMPLE_CSV, TEMPLATE_CSV, parseCatalogue } from "@/lib/csvParse";
import AuditResults, { type AuditSummary } from "./AuditResults";

type AuditResponse = {
  summary: AuditSummary;
  lines: AuditLine[];
  proof?: string;
  signed_at?: string;
};

/** A completed audit, with what was needed to produce and later save it. */
type Run = {
  response: AuditResponse;
  /** Amounts as submitted, one per line, for lines the engine could not price. */
  inputs: number[];
  ranAt: Date;
  /** The catalogue text this was run from. */
  text: string;
  sample: boolean;
  entries: number;
  transport: "vessel" | "air";
};

/** Files larger than the proxy accepts are refused here, with a reason,
 *  rather than after an upload that ends in an unexplained 413. */
const MAX_TEXT = 1_900_000;

const focusRing =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

const timeOf = (d: Date) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

function isResponse(x: unknown): x is AuditResponse {
  if (typeof x !== "object" || x === null) return false;
  const r = x as { summary?: unknown; lines?: unknown };
  return typeof r.summary === "object" && r.summary !== null && Array.isArray(r.lines);
}

function downloadCsv(lines: AuditLine[]) {
  // Shares the formula-neutralising emitter with the saved-catalogue export
  // (lib/csv.ts): product descriptions and SKUs are attacker-controlled, and a
  // bare quote-only emitter does not stop a leading `=` being read as a formula
  // when the file is opened in a spreadsheet.
  const csv = toCsv(lines.map((l) => auditExportRow(l)), AUDIT_COLUMNS);
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `htsdesk-audit-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function AuditClient({
  signedIn, maxRows,
}: {
  signedIn: boolean;
  /** Products per audit for this visitor. The server enforces it. */
  maxRows: number;
}) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [attempted, setAttempted] = useState(false);
  const [entries, setEntries] = useState("1");
  const [transport, setTransport] = useState<"vessel" | "air">("vessel");
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [fileNote, setFileNote] = useState<string | null>(null);
  // After a successful run the import panel folds into a one-line summary so
  // the results start near the top. "Edit catalogue" opens it again.
  const [editing, setEditing] = useState(true);
  const barRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const focusAfter = useRef<"bar" | "text" | null>(null);
  const draft = useSavedDraft();

  // The panel that just held keyboard focus (the Run button, or Edit) is gone
  // after the swap; put focus where the visitor's attention now is.
  useEffect(() => {
    const target = focusAfter.current;
    focusAfter.current = null;
    if (target === "bar") barRef.current?.focus();
    if (target === "text") textRef.current?.focus();
  }, [editing]);

  useEffect(() => {
    if (!busy) return;
    const t0 = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(id);
  }, [busy]);

  const parsed = useMemo(() => (text.trim() ? parseCatalogue(text) : null), [text]);
  const isSample = text === SAMPLE_CSV;
  const entryCount = Math.max(1, Math.min(100_000, Math.floor(Number(entries)) || 1));
  const overLimit = parsed?.ok && parsed.items.length > maxRows;
  const rowCount = parsed?.ok ? parsed.items.length : countRows(text);

  // An anonymous visitor's only way to carry work across sign-up is the
  // draft in their own browser (lib/draft.ts). It is written just before they
  // follow any link to sign up or sign in, wherever on the page it is.
  useEffect(() => {
    if (signedIn || isSample || !text.trim()) return;
    const onLink = (e: Event) => {
      const a = (e.target as Element | null)?.closest?.("a");
      if (!a) return;
      let url: URL;
      try { url = new URL(a.href, window.location.href); } catch { return; }
      if (url.origin !== window.location.origin) return;
      if (url.pathname !== "/signup" && url.pathname !== "/login") return;
      writeDraft({ text, entries: entryCount, transport, rows: rowCount });
    };
    const events = ["click", "auxclick", "contextmenu"] as const;
    for (const ev of events) document.addEventListener(ev, onLink, true);
    return () => { for (const ev of events) document.removeEventListener(ev, onLink, true); };
  }, [signedIn, isSample, text, entryCount, transport, rowCount]);

  function restoreDraft() {
    if (!draft) return;
    setText(draft.text);
    setEntries(String(draft.entries));
    setTransport(draft.transport);
    setAttempted(false);
    setFileNote("Restored your earlier catalogue. Check it, then run the audit when you are ready.");
    setEditing(true);
    focusAfter.current = "text";
    textRef.current?.focus();
    clearDraft();
  }

  async function runAudit() {
    setAttempted(true);
    if (busy) return;
    const p = parseCatalogue(text);
    if (!p.ok || p.items.length > maxRows) return; // the problems are already on screen, in an alert

    setBusy(true);
    setElapsed(0);
    setError(null);
    try {
      // Every data row goes to the server, in order, with its row number. A
      // row that cannot be read is sent with amount 0 so it comes back as an
      // error line with a reason, never silently missing.
      const items = p.items.map(({ row, sku, description, country, value, hts, quantity, quantityUnit, program }) => ({
        row, sku, description, country, value, hts,
        ...(quantity !== null ? { quantity } : {}),
        ...(quantityUnit ? { quantity_unit: quantityUnit } : {}),
        ...(program ? { preference_program: program } : {}),
      }));
      const res = await fetch("/api/audit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items, entries: entryCount, by_vessel: transport === "vessel" }),
        signal: AbortSignal.timeout(70_000),
      });

      let payload: unknown = null;
      try { payload = await res.json(); } catch { /* not JSON: handled below */ }

      if (!res.ok) {
        const detail = (payload as { detail?: unknown } | null)?.detail;
        setError(
          typeof detail === "string" ? detail
            : res.status === 429 ? "You are sending audits too quickly. Wait a moment and try again."
            : `The audit could not be completed (HTTP ${res.status}). Your catalogue is unchanged; try again.`,
        );
        return;
      }
      if (!isResponse(payload) || payload.lines.length !== items.length) {
        setError("The audit returned an unexpected response, so nothing was shown. Try again.");
        return;
      }
      setRun({
        response: payload, inputs: p.items.map((i) => i.value),
        ranAt: new Date(), text, sample: isSample, entries: entryCount, transport,
      });
      setSaveError(null);
      setEditing(false);
      focusAfter.current = "bar";
      if (!signedIn && !isSample) {
        writeDraft({ text, entries: entryCount, transport, rows: p.items.length });
      }
    } catch (e) {
      const timedOut = e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError");
      setError(
        timedOut
          ? "The audit took too long and was stopped. Try a smaller catalogue, or try again."
          : "Could not reach the audit service. Check your connection and try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = ""; // so choosing the same file again still fires
    if (!f) return;
    try {
      if (f.size > MAX_TEXT) {
        setFileNote(`${f.name} is larger than the 2 MB limit. Split it into smaller files.`);
        return;
      }
      const body = await f.text();
      if (body.length > MAX_TEXT) {
        setFileNote(`${f.name} is larger than the 2 MB limit for one audit. Split it into smaller files.`);
        return;
      }
      setText(body);
      setAttempted(false);
      setFileNote(`Loaded ${f.name}.`);
    } catch {
      setFileNote(`Could not read ${f.name}. Try saving it as a CSV and choosing it again.`);
    }
  }

  async function save() {
    if (!run || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const { response } = run;
      const lines = response.lines.map((l) => projectLine(l));
      if (lines.some((l) => l === null)) {
        setSaveError("Run the audit again to save it.");
        return;
      }
      const res = await saveCatalogueAction({
        name,
        lines,
        dataset_revision: response.summary.dataset_revision ?? "",
        assumptions: response.summary.assumptions ?? [],
        mpf: response.summary.mpf ?? 0,
        signed_at: response.signed_at ?? "",
        proof: response.proof ?? null,
        inputs: run.inputs,
      });
      if (res.error || !res.id) {
        setSaveError(res.error ?? "Could not save. Try again.");
        return;
      }
      clearDraft(); // it has served its purpose; do not leave supplier data behind
      router.push(`/catalogues/${res.id}`);
    } catch {
      setSaveError("Could not save just now. Your results are still here; try again.");
    } finally {
      setSaving(false);
    }
  }

  const problems = parsed && !parsed.ok ? parsed.problems : [];
  const stale = run !== null && (run.text !== text || run.entries !== entryCount || run.transport !== transport);
  const templateHref = `data:text/csv;charset=utf-8,${encodeURIComponent(TEMPLATE_CSV)}`;

  const preflight = parsed?.ok ? parsed : null;

  return (
    <div className="space-y-6">
      <ol className="workflow-steps" aria-label="Audit workflow">
        {["Import your products", "Review the estimates", "Save and monitor"].map((label, index) => (
          <li key={label} className="workflow-step" aria-current={(run ? 1 : 0) === index ? "step" : undefined}>
            <span>{index + 1}</span><span>{label}</span>
          </li>
        ))}
      </ol>
      {signedIn && draft ? (
        <DraftNotice draft={draft} onRestore={restoreDraft} onDiscard={clearDraft} />
      ) : null}
      {run && !editing ? (
        <section
          ref={barRef}
          tabIndex={-1}
          aria-label="Catalogue summary"
          data-testid="import-summary"
          className="panel flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-5 py-4 sm:px-6"
        >
          <p className="text-[14px] text-muted">
            <span className="text-[15px] font-medium text-ink">
              <span className="mono">{run.response.lines.length.toLocaleString()}</span>{" "}
              {run.response.lines.length === 1 ? "product" : "products"}
            </span>{" "}
            · {run.entries} formal {run.entries === 1 ? "entry" : "entries"} · {run.transport === "vessel" ? "vessel" : "air"} shipment · audited {timeOf(run.ranAt)}
          </p>
          <button
            type="button"
            onClick={() => { focusAfter.current = "text"; setEditing(true); }}
            className={`btn btn-secondary ${focusRing}`}
          >
            Edit catalogue
          </button>
        </section>
      ) : (
      <section className="panel overflow-hidden" aria-labelledby="import-heading">
        <div className="panel-heading">
          <h2 id="import-heading" className="panel-title"><span className="step-number" aria-hidden="true">1</span>Import your catalogue</h2>
          <span className="flex items-center gap-4">
            <span className="mono text-xs text-faint">Up to {maxRows.toLocaleString()} products per audit</span>
            {run ? (
              <button
                type="button"
                onClick={() => { focusAfter.current = "bar"; setEditing(false); }}
                className={`text-[14px] text-muted hover:underline ${focusRing}`}
              >
                Collapse
              </button>
            ) : null}
          </span>
        </div>
        <div className="space-y-5 p-5 sm:p-6">
      <div className="space-y-2">
        <label htmlFor="catalogue-text" className="block text-[15px] font-medium">
          Your catalogue
        </label>
        <p id="catalogue-help" className="text-[13px] text-muted">
          {EXPECTED_FORMAT}{" "}
          <a href={templateHref} download="htsdesk-template.csv" className={`hover:underline text-accent ${focusRing}`}>
            Download template
          </a>
        </p>
        <textarea
          ref={textRef}
          id="catalogue-text"
          aria-describedby="catalogue-help catalogue-preflight"
          value={text}
          onChange={(e) => { setText(e.target.value); setAttempted(false); }}
          rows={7}
          spellCheck={false}
          placeholder={"sku,description,country,value,hts\nTS-001,mens knitted cotton t-shirt,China,48000,"}
          className={`mono w-full rounded-md border p-4 text-[13px] leading-relaxed border-rule bg-paper text-ink ${focusRing}`}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <input
          id="catalogue-file"
          type="file"
          accept=".csv,text/csv,text/plain"
          onChange={onFile}
          className="peer sr-only"
        />
        <label
          htmlFor="catalogue-file"
          className="btn btn-secondary cursor-pointer peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent"
        >
          Upload CSV
        </label>
        <button
          type="button"
          onClick={() => { setText(SAMPLE_CSV); setAttempted(false); setFileNote(null); }}
          className={`btn btn-secondary ${focusRing}`}
        >
          Try a sample
        </button>
        {text ? (
          <button
            type="button"
            onClick={() => { setText(""); setAttempted(false); setFileNote(null); }}
            className={`px-2 py-2 text-[14px] text-muted hover:underline ${focusRing}`}
          >
            Clear
          </button>
        ) : null}
      </div>

      <div id="catalogue-preflight" role={attempted && problems.length ? "alert" : "status"} className="space-y-2 text-[14px]">
        {fileNote ? <p className="text-muted">{fileNote}</p> : null}
        {isSample && !run?.sample ? (
          <p className="rounded border-l-2 py-2 pl-3 border-caution bg-caution-soft text-caution-ink">
            This is sample data, not yours. Replace it with your catalogue, or clear it.
          </p>
        ) : null}
        {preflight ? (
          <p className="text-muted">
            <span className="mono">{preflight.items.length.toLocaleString()}</span> rows read ·{" "}
            <span className="mono">{preflight.incomplete.toLocaleString()}</span> look incomplete. Every row is
            still audited; rows the engine cannot price come back marked, not dropped.
            {preflight.ignored.length ? ` Ignored columns: ${preflight.ignored.join(", ")}.` : ""}
          </p>
        ) : null}
        {overLimit ? (
          <p className="text-caution-ink">
            That is more than the {maxRows.toLocaleString()} products one audit takes
            {signedIn ? "" : " without an account"}. The audit will refuse it;{" "}
            {signedIn ? (
              "split the file."
            ) : (
              <>
                split the file, or{" "}
                <a href="/signup?next=/audit" className="font-medium underline">create a free account</a>{" "}
                for up to {LIMITS.account.productsPerAudit.toLocaleString()} at a time.
              </>
            )}
          </p>
        ) : null}
        {problems.length ? (
          <div className="rounded border-l-2 py-2 pl-3 border-danger bg-caution-soft">
            <p className="font-medium text-danger">This catalogue cannot be audited yet.</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-ink">
              {problems.map((t, i) => <li key={i}>{t}</li>)}
            </ul>
            <p className="mt-2 text-muted">
              {EXPECTED_FORMAT}{" "}
              <a href={templateHref} download="htsdesk-template.csv" className={`hover:underline text-accent ${focusRing}`}>
                Download template
              </a>
            </p>
          </div>
        ) : null}
      </div>

      <details className="rounded border p-3 text-[14px] border-border">
        <summary className={`cursor-pointer font-medium ${focusRing}`}>
          Assumptions: {entryCount} formal {entryCount === 1 ? "entry" : "entries"}, {transport === "vessel" ? "vessel" : "air"} shipment
        </summary>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="lbl" id="entry-count-label">Formal entries</span>
            <input
              type="number"
              inputMode="numeric"
              aria-labelledby="entry-count-label"
              aria-describedby="entry-count-help"
              min={1}
              max={100000}
              step={1}
              value={entries}
              onChange={(e) => setEntries(e.target.value)}
              className={`mono w-32 border px-3 py-2 text-[14px] border-border bg-surface text-ink ${focusRing}`}
            />
            <span id="entry-count-help" className="text-[12px] text-muted">
              How many customs entries this value is spread over. The Merchandise Processing Fee minimum
              and maximum apply to each.
            </span>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="lbl" id="transport-label">Transport</span>
            <select
              aria-labelledby="transport-label"
              aria-describedby="transport-help"
              value={transport}
              onChange={(e) => setTransport(e.target.value as "vessel" | "air")}
              className={`w-40 border px-3 py-2 text-[14px] border-border bg-surface text-ink ${focusRing}`}
            >
              <option value="vessel">Vessel (ocean)</option>
              <option value="air">Air</option>
            </select>
            <span id="transport-help" className="text-[12px] text-muted">Vessel shipments carry the Harbor Maintenance Fee; air does not.</span>
          </label>
        </div>
      </details>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={runAudit}
          disabled={busy || Boolean(overLimit)}
          className={`btn btn-primary ${focusRing}`}
        >
          {busy ? "Auditing…" : "Run audit"}
        </button>
        <p role="status" className="text-[14px] text-muted">
          {busy
            ? `Auditing ${preflight?.items.length.toLocaleString() ?? ""} rows… ${elapsed}s. Classifying takes a fraction of a second per product, so a large catalogue can take up to a minute.`
            : ""}
        </p>
      </div>

        </div>
      </section>
      )}

      {error ? (
        <div role="alert" className="rounded border-l-2 py-2 pl-3 text-[14px] border-danger bg-caution-soft text-danger">
          <p>{error}</p>
          {run ? (
            <p className="mt-1 text-ink">
              The results below are the previous successful audit, from {timeOf(run.ranAt)}.
            </p>
          ) : null}
        </div>
      ) : null}

      {run ? (
        <>
          {run.sample ? (
            <p className="rounded border-l-2 py-2 pl-3 text-[14px] border-caution bg-caution-soft text-caution-ink">
              These are results for the sample catalogue, not your data. They cannot be saved.
            </p>
          ) : null}
          {stale ? (
            <p className="rounded border-l-2 py-2 pl-3 text-[14px] border-caution bg-caution-soft text-caution-ink">
              You have changed the catalogue or shipping assumptions since this audit ({timeOf(run.ranAt)}). Run the audit again to see
              results for what is above.
            </p>
          ) : null}

          <AuditResults
            summary={run.response.summary}
            lines={run.response.lines}
            inputs={run.inputs}
          />

          <div className="flex flex-wrap items-end gap-3 border-t pt-5 border-border">
            {signedIn ? (
              <>
                <label className="flex flex-col gap-1.5">
                  <span className="lbl">Save as</span>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Autumn range, China"
                    className={`border px-3 py-2 text-[14px] sm:w-72 border-border bg-surface text-ink ${focusRing}`}
                  />
                </label>
                <button
                  type="button"
                  disabled={saving || run.sample || stale}
                  onClick={save}
                  className={`btn btn-primary ${focusRing}`}
                >
                  {saving ? "Saving…" : "Save and watch these codes"}
                </button>
              </>
            ) : (
              <div className="max-w-2xl space-y-2 text-[14px] text-muted">
                <p>
                  <a href="/signup?next=/audit" className="font-medium hover:underline text-accent">
                    Create a free account
                  </a>{" "}
                  or{" "}
                  <a href="/login?next=/audit" className="font-medium hover:underline text-accent">
                    sign in
                  </a>{" "}
                  to save this catalogue — every priced code in it is then watched, and you are told when a
                  tariff action names one.
                </p>
                {draft ? (
                  <p className="text-[13px]">
                    So you do not have to start again, this catalogue is kept in this browser for 24 hours. It is
                    not sent to us, and it is cleared when you sign out.{" "}
                    <button type="button" onClick={clearDraft} className={`text-accent underline ${focusRing}`}>
                      Forget it now
                    </button>
                  </p>
                ) : null}
              </div>
            )}
            <button
              type="button"
              onClick={() => downloadCsv(run.response.lines)}
              className={`btn btn-secondary ${focusRing}`}
            >
              Export CSV
            </button>
          </div>

          {saving ? <p role="status" className="text-[13px] text-muted">Saving your catalogue…</p> : null}
          {saveError ? (
            <p role="alert" className="text-[13px] text-danger">{saveError}</p>
          ) : null}
          {signedIn ? (
            <p className="text-[12px] text-faint">
              Every line is saved, including the ones that could not be priced, so nothing drops off your
              review list. Only priced lines with a real code are watched. You can keep up to{" "}
              {LIMITS.account.savedCatalogues} saved catalogues.
            </p>
          ) : null}

          <p className="text-[13px] text-muted">
            Classifications are ranked from CBP ruling precedent. Confirm anything marked low confidence, and
            anything flagged for scope review, before you file — the reasonable-care duty stays with the
            importer of record.
          </p>
        </>
      ) : null}
    </div>
  );
}
