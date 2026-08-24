"use client";

import { useState } from "react";

type Line = {
  sku: string;
  description: string;
  hts: string | null;
  confidence?: string;
  country?: string;
  entered_value?: number;
  duty?: number;
  effective_rate_pct?: number;
  refundable?: number;
  scope_unverified?: string[];
  error?: string;
};

type Result = {
  summary: {
    items: number;
    entered_value: number;
    duty: number;
    effective_rate_pct: number;
    potentially_refundable: number;
    unclassified: number;
    needs_scope_review: number;
  };
  lines: Line[];
};

const SAMPLE = `sku,description,country,value,hts
TS-001,mens knitted cotton t-shirt short sleeve,China,48000,
BP-220,nylon backpack with zipper closure,China,31000,
LI-20V,lithium-ion rechargeable battery pack 20V,Vietnam,75000,
CH-14,upholstered wooden dining chair,China,52000,
MG-09,ceramic coffee mug,Germany,12000,`;

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

/** Minimal CSV parse: handles quoted fields and embedded commas. */
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (ch !== "\r") cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }

  const [head, ...body] = rows.filter((r) => r.some((c) => c.trim()));
  if (!head) return [];
  const keys = head.map((h) => h.trim().toLowerCase());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
}

export default function AuditClient({ apiBase }: { apiBase: string }) {
  const [text, setText] = useState(SAMPLE);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const rows = parseCsv(text);
      const items = rows
        .map((r) => ({
          sku: r.sku ?? "",
          description: r.description ?? "",
          country: r.country ?? "",
          value: Number(r.value ?? 0),
          hts: r.hts ? r.hts : null,
        }))
        .filter((i) => i.description && i.country && i.value > 0);

      if (!items.length) {
        setError("No usable rows. Columns needed: description, country, value. sku and hts are optional.");
        return;
      }

      const res = await fetch(`${apiBase}/api/audit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items }),
      });
      if (!res.ok) {
        setError(`Audit failed (${res.status}). Is the API running?`);
        return;
      }
      setResult((await res.json()) as Result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unexpected error");
    } finally {
      setBusy(false);
    }
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) setText(await f.text());
  }

  const s = result?.summary;
  const border = { borderColor: "var(--border)" };

  return (
    <div className="space-y-6">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={9}
        spellCheck={false}
        className="tabular w-full rounded-md border p-3 font-mono text-[13px]"
        style={{ ...border, background: "var(--bg)", color: "var(--ink)" }}
      />

      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={run}
          disabled={busy}
          className="rounded-md px-4 py-2 text-[15px] font-medium disabled:opacity-50"
          style={{ background: "var(--accent)", color: "var(--bg)" }}
        >
          {busy ? "Auditing…" : "Run audit"}
        </button>
        <label className="cursor-pointer rounded-md border px-3 py-2 text-[14px]" style={border}>
          Upload CSV
          <input type="file" accept=".csv,text/csv" onChange={onFile} className="hidden" />
        </label>
      </div>

      {error ? (
        <p className="rounded border-l-2 py-2 pl-3 text-[14px]"
           style={{ borderColor: "var(--danger)", background: "var(--warn-soft)", color: "var(--danger)" }}>
          {error}
        </p>
      ) : null}

      {s ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ["Entered value", money(s.entered_value), `${s.items} lines`],
              ["Duty and fees", money(s.duty), `${s.effective_rate_pct}% effective`],
              ["Potentially refundable", money(s.potentially_refundable), "IEEPA, struck down"],
              ["Needs review", String(s.needs_scope_review + s.unclassified), "scope or classification"],
            ].map(([label, value, sub]) => (
              <div key={label} className="rounded-lg border p-4"
                   style={{ ...border, background: "var(--surface)" }}>
                <div className="text-[12px] uppercase tracking-wide" style={{ color: "var(--muted)" }}>
                  {label}
                </div>
                <div className="tabular mt-1 text-2xl font-semibold">{value}</div>
                <div className="text-[12px]" style={{ color: "var(--muted)" }}>{sub}</div>
              </div>
            ))}
          </div>

          <div className="scroll-x">
            <table className="w-full min-w-[760px] text-[14px]">
              <thead>
                <tr className="border-b text-left" style={{ ...border, color: "var(--muted)" }}>
                  <th className="py-2 font-medium">SKU</th>
                  <th className="py-2 font-medium">HTS</th>
                  <th className="py-2 font-medium">Confidence</th>
                  <th className="py-2 font-medium">Origin</th>
                  <th className="py-2 text-right font-medium">Value</th>
                  <th className="py-2 text-right font-medium">Duty</th>
                  <th className="py-2 text-right font-medium">Rate</th>
                  <th className="py-2 pl-3 font-medium">Flags</th>
                </tr>
              </thead>
              <tbody>
                {result!.lines.map((l, i) => (
                  <tr key={`${l.sku}-${i}`} className="border-b" style={border}>
                    <td className="py-2">{l.sku || "—"}</td>
                    <td className="tabular py-2">
                      {l.hts ? (
                        <a href={`/hts/${l.hts}`} className="hover:underline" style={{ color: "var(--accent)" }}>
                          {l.hts}
                        </a>
                      ) : "—"}
                    </td>
                    <td className="py-2">{l.confidence ?? "—"}</td>
                    <td className="py-2">{l.country ?? "—"}</td>
                    <td className="tabular py-2 text-right">
                      {l.entered_value !== undefined ? money(l.entered_value) : "—"}
                    </td>
                    <td className="tabular py-2 text-right">
                      {l.duty !== undefined ? money(l.duty) : "—"}
                    </td>
                    <td className="tabular py-2 text-right">
                      {l.effective_rate_pct !== undefined ? `${l.effective_rate_pct}%` : "—"}
                    </td>
                    <td className="py-2 pl-3 text-[12px]" style={{ color: "var(--muted)" }}>
                      {l.error
                        ? l.error
                        : l.scope_unverified?.length
                          ? `${l.scope_unverified.length} heading(s) need scope review`
                          : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="text-[13px]" style={{ color: "var(--muted)" }}>
            Classifications are ranked from CBP ruling precedent. Confirm anything
            marked low confidence, and anything flagged for scope review, before
            you file — the reasonable-care duty stays with the importer of record.
          </p>
        </>
      ) : null}
    </div>
  );
}
