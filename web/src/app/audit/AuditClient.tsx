"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { saveCatalogueAction } from "@/lib/actions";
import { AUDIT_COLUMNS, auditExportRow, toCsv } from "@/lib/csv";
import { projectLine, type AuditLine } from "@/lib/auditModel";
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
  /** Products per audit on the viewer's plan. The server enforces it. */
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

  useEffect(() => {
    if (!busy) return;
    const t0 = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(id);
  }, [busy]);

  const parsed = useMemo(() => (text.trim() ? parseCatalogue(text) : null), [text]);
  const isSample = text === SAMPLE_CSV;
  const entryCount = Math.max(1, Math.min(100_000, Math.floor(Number(entries)) || 1));
  const overPlan = parsed?.ok && parsed.items.length > maxRows;

  async function runAudit() {
    setAttempted(true);
    if (busy) return;
    const p = parseCatalogue(text);
    if (!p.ok) return; // the problems are already on screen, in an alert

    setBusy(true);
    setElapsed(0);
    setError(null);
    try {
      // Every data row goes to the server, in order, with its row number. A
      // row that cannot be read is sent with amount 0 so it comes back as an
      // error line with a reason, never silently missing.
      const items = p.items.map(({ row, sku, description, country, value, hts }) => ({
        row, sku, description, country, value, hts,
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
        ranAt: new Date(), text, sample: isSample,
      });
      setSaveError(null);
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
      router.push(`/catalogues/${res.id}`);
    } catch {
      setSaveError("Could not save just now. Your results are still here; try again.");
    } finally {
      setSaving(false);
    }
  }

  const problems = parsed && !parsed.ok ? parsed.problems : [];
  const stale = run !== null && run.text !== text;
  const templateHref = `data:text/csv;charset=utf-8,${encodeURIComponent(TEMPLATE_CSV)}`;

  const preflight = parsed?.ok ? parsed : null;

  return (
    <div className="space-y-6">
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
          id="catalogue-text"
          aria-describedby="catalogue-help catalogue-preflight"
          value={text}
          onChange={(e) => { setText(e.target.value); setAttempted(false); }}
          rows={9}
          spellCheck={false}
          placeholder={"sku,description,country,value,hts\nTS-001,mens knitted cotton t-shirt,China,48000,"}
          className={`mono w-full rounded-md border p-3 text-[13px] border-border bg-paper text-ink ${focusRing}`}
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
          className="cursor-pointer rounded-md border px-3 py-2 text-[14px] border-rule peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent"
        >
          Upload CSV
        </label>
        <button
          type="button"
          onClick={() => { setText(SAMPLE_CSV); setAttempted(false); setFileNote(null); }}
          className={`rounded-md border px-3 py-2 text-[14px] border-rule ${focusRing}`}
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
        {isSample ? (
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
        {overPlan ? (
          <p className="text-caution-ink">
            That is more than the {maxRows.toLocaleString()} products your plan audits at once. The audit will
            refuse it; split the file.
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
            <span className="lbl">Formal entries</span>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={100000}
              step={1}
              value={entries}
              onChange={(e) => setEntries(e.target.value)}
              className={`mono w-32 border px-3 py-2 text-[14px] border-border bg-surface text-ink ${focusRing}`}
            />
            <span className="text-[12px] text-muted">
              How many customs entries this value is spread over. The Merchandise Processing Fee minimum
              and maximum apply to each.
            </span>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="lbl">Transport</span>
            <select
              value={transport}
              onChange={(e) => setTransport(e.target.value as "vessel" | "air")}
              className={`w-40 border px-3 py-2 text-[14px] border-border bg-surface text-ink ${focusRing}`}
            >
              <option value="vessel">Vessel (ocean)</option>
              <option value="air">Air</option>
            </select>
            <span className="text-[12px] text-muted">Vessel shipments carry the Harbor Maintenance Fee; air does not.</span>
          </label>
        </div>
      </details>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={runAudit}
          disabled={busy}
          className={`rounded-md px-4 py-2 text-[15px] font-medium disabled:opacity-50 bg-accent text-on-accent ${focusRing}`}
        >
          {busy ? "Auditing…" : "Run audit"}
        </button>
        <p role="status" className="text-[14px] text-muted">
          {busy
            ? `Auditing ${preflight?.items.length.toLocaleString() ?? ""} rows… ${elapsed}s. Classifying takes a fraction of a second per product, so a large catalogue can take up to a minute.`
            : ""}
        </p>
      </div>

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
              You have changed the catalogue since this audit ({timeOf(run.ranAt)}). Run the audit again to see
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
                  disabled={saving || run.sample}
                  onClick={save}
                  className={`px-4 py-2 text-[14px] font-medium disabled:opacity-60 bg-accent text-on-accent ${focusRing}`}
                >
                  {saving ? "Saving…" : "Save and watch these codes"}
                </button>
              </>
            ) : (
              <p className="text-[14px] text-muted">
                <a href="/signup" className="font-medium hover:underline text-accent">
                  Create a free account
                </a>{" "}
                to save this catalogue — every priced code in it is then watched, and you are told when a
                tariff action names one.
              </p>
            )}
            <button
              type="button"
              onClick={() => downloadCsv(run.response.lines)}
              className={`border px-4 py-2 text-[14px] font-medium border-rule ${focusRing}`}
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
              review list. Only priced lines with a real code are watched.
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
