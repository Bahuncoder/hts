"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  EXPECTED_FORMAT, TEMPLATE_CSV, parseRefundCheckCsv, type RefundCheckRow,
} from "@/lib/refundCheckCsv";
import { money2 } from "@/lib/api";
import { Badge, Note } from "@/components/ui";

const MAX_TEXT = 1_900_000;
const focusRing = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

type ItemResult = {
  row: number; description: string; country: string; entryHts: string | null; entryDate: string;
  dutyPaid: number; liquidationDate: string | null; computedHts: string | null; computedDuty: number | null;
  struckDownRefundable: number; pscEligible: string; pscDetail: string;
  protestDeadline: string; protestDetail: string; disclaimer: string; status: string;
};

type RunResult = { id: string; items: ItemResult[]; rejected: { row: number; reason: string }[] };

const templateHref = `data:text/csv;charset=utf-8,${encodeURIComponent(TEMPLATE_CSV)}`;

export default function RefundCheckClient({ maxRows }: { maxRows: number }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [fileNote, setFileNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);

  const parsed = useMemo<{ ok: true; items: RefundCheckRow[]; incomplete: number } | { ok: false; problems: string[] } | null>(
    () => (text.trim() ? parseRefundCheckCsv(text) : null), [text],
  );
  const overLimit = parsed?.ok && parsed.items.length > maxRows;

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    if (f.size > MAX_TEXT) { setFileNote(`${f.name} is larger than the 2 MB limit.`); return; }
    try {
      const body = await f.text();
      setText(body);
      setFileNote(`Loaded ${f.name}.`);
    } catch {
      setFileNote(`Could not read ${f.name}. Try saving it as a CSV and choosing it again.`);
    }
  }

  async function run() {
    if (!parsed?.ok || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/refund-check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim() || "Untitled refund check",
          items: parsed.items.map((it) => ({
            sku: it.sku, description: it.description, country: it.country, value: it.value,
            entryHts: it.entryHts, entryDate: it.entryDate, dutyPaid: it.dutyPaid,
            liquidationDate: it.liquidationDate,
          })),
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.detail ?? "Something went wrong. Try again shortly.");
        return;
      }
      setResult(body as RunResult);
      router.refresh();
    } catch {
      setError("The duty engine is unavailable. Try again shortly.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="panel space-y-5 p-5 sm:p-6">
        <div className="space-y-2">
          <label htmlFor="refund-check-name" className="block text-[15px] font-medium">Name this check</label>
          <input
            id="refund-check-name" value={name} onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Q3 2026 China entries" maxLength={200}
            className={`field-control w-full ${focusRing}`}
            style={{ borderColor: "var(--rule)", background: "var(--surface)", color: "var(--ink)" }}
          />
        </div>
        <div className="space-y-2">
          <label htmlFor="refund-check-text" className="block text-[15px] font-medium">Entries you already filed</label>
          <p className="text-[13px] text-muted">
            {EXPECTED_FORMAT}{" "}
            <a href={templateHref} download="htsdesk-refund-check-template.csv" className={`hover:underline text-accent ${focusRing}`}>
              Download template
            </a>
          </p>
          <textarea
            id="refund-check-text" value={text} onChange={(e) => setText(e.target.value)}
            rows={7} spellCheck={false}
            placeholder={"sku,description,country,value,hts,entry date,duty paid,liquidation date"}
            className={`mono w-full rounded-md border p-4 text-[13px] leading-relaxed border-rule bg-paper text-ink ${focusRing}`}
          />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <input id="refund-check-file" type="file" accept=".csv,text/csv,text/plain" onChange={onFile} className="peer sr-only" />
          <label htmlFor="refund-check-file" className="btn btn-secondary cursor-pointer peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent">
            Upload CSV
          </label>
          {text ? (
            <button type="button" onClick={() => { setText(""); setFileNote(null); }} className={`px-2 py-2 text-[14px] text-muted hover:underline ${focusRing}`}>
              Clear
            </button>
          ) : null}
        </div>
        {fileNote ? <p className="text-[13px] text-muted">{fileNote}</p> : null}
        {parsed && !parsed.ok ? (
          <Note role="alert">{parsed.problems.join(" ")}</Note>
        ) : null}
        {overLimit ? (
          <Note role="alert">
            {parsed && parsed.ok ? parsed.items.length : 0} entries exceeds the {maxRows.toLocaleString()} allowed in one run. Split it across several runs.
          </Note>
        ) : null}
        {error ? <p role="alert" className="text-[13px] text-danger">{error}</p> : null}
        <button
          type="button" onClick={run}
          disabled={!parsed?.ok || overLimit || busy}
          className={`btn btn-primary ${focusRing}`}
        >
          {busy ? "Checking…" : "Run refund check"}
        </button>
      </div>

      {result ? <RefundCheckResults result={result} /> : null}
    </div>
  );
}

function RefundCheckResults({ result }: { result: RunResult }) {
  const total = result.items.reduce((sum, it) => sum + it.struckDownRefundable, 0);
  return (
    <div className="panel space-y-5 p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[17px] font-semibold">Results</h2>
        <a href={`/refund-check/${result.id}`} className="text-[14px] font-medium text-accent hover:underline">
          View saved check →
        </a>
      </div>
      {total > 0 ? (
        <p className="border-l-2 py-2 pl-3 text-[13px] border-recover">
          <span className="lbl block" style={{ color: "var(--recover)" }}>Scenario estimate</span>
          About <span className="mono font-medium">{money2(total)}</span> of the duty paid across these entries may
          be recoverable (struck-down IEEPA duty). This is not a claim amount — see each entry&rsquo;s timing
          guidance and confirm with CBP or a licensed customs broker.
        </p>
      ) : null}
      {result.rejected.length > 0 ? (
        <Note role="alert">
          {result.rejected.length} row{result.rejected.length === 1 ? "" : "s"} could not be checked:{" "}
          {result.rejected.map((r) => `row ${r.row} (${r.reason})`).join("; ")}.
        </Note>
      ) : null}
      <div className="scroll-x">
        <table className="w-full min-w-[720px] text-[13px]">
          <thead>
            <tr className="border-b border-border text-left text-faint">
              <th className="py-2 pr-4 font-medium">Description</th>
              <th className="py-2 pr-4 font-medium">Entry date</th>
              <th className="py-2 pr-4 font-medium">Duty paid</th>
              <th className="py-2 pr-4 font-medium">Refundable</th>
              <th className="py-2 pr-4 font-medium">PSC</th>
              <th className="py-2 font-medium">Protest deadline</th>
            </tr>
          </thead>
          <tbody>
            {result.items.map((it) => (
              <tr key={it.row} className="border-b border-hair align-top">
                <td className="py-2 pr-4">{it.description}<div className="text-faint">{it.country}</div></td>
                <td className="mono py-2 pr-4">{it.entryDate}</td>
                <td className="mono py-2 pr-4">{money2(it.dutyPaid)}</td>
                <td className="mono py-2 pr-4">
                  {it.struckDownRefundable > 0
                    ? <span style={{ color: "var(--recover)" }}>{money2(it.struckDownRefundable)}</span>
                    : "—"}
                </td>
                <td className="py-2 pr-4"><Badge tone={it.pscEligible === "may be available" ? "good" : "neutral"}>{it.pscEligible}</Badge></td>
                <td className="py-2">{it.protestDeadline}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[12px] text-faint">{result.items[0]?.disclaimer}</p>
    </div>
  );
}
