"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { saveCatalogueAction } from "@/lib/actions";
import { AUDIT_COLUMNS, toCsv } from "@/lib/csv";

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
    submitted: number;
    truncated: boolean;
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
  n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });

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
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }

  const [head, ...body] = rows.filter((r) => r.some((c) => c.trim()));
  if (!head) return [];
  const keys = head.map((h) => h.trim().toLowerCase());
  return body.map((r) =>
    Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])),
  );
}

function downloadCsv(lines: Line[]) {
  // Shares the formula-neutralizing emitter with the saved-catalogue export
  // (lib/csv.ts): product descriptions and SKUs here are attacker-controlled,
  // and a bare quote-only emitter does not stop a leading `=` from being read
  // as a formula when the file is opened in a spreadsheet.
  const rows = lines.map((l) => ({
    sku: l.sku,
    description: l.description,
    country: l.country ?? "",
    hts: l.hts,
    confidence: l.confidence ?? "",
    entered_value: l.entered_value?.toFixed(2) ?? "",
    duty: l.duty?.toFixed(2) ?? "",
    effective_rate_pct: l.effective_rate_pct?.toFixed(2) ?? "",
    refundable: l.refundable?.toFixed(2) ?? "",
    flags: l.error ? l.error : l.scope_unverified?.length ? "scope unverified" : "",
  }));
  const csv = toCsv(rows, AUDIT_COLUMNS);
  const url = URL.createObjectURL(
    new Blob([csv], { type: "text/csv;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `htsdesk-audit-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function AuditClient({ signedIn }: { signedIn: boolean }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
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
        setError(
          "No usable rows. Columns needed: description, country, value. sku and hts are optional.",
        );
        return;
      }

      const res = await fetch("/api/audit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items }),
      });
      const payload = await res.json();
      if (!res.ok) {
        setError(
          typeof payload?.detail === "string"
            ? payload.detail
            : `Audit failed (${res.status}).`,
        );
        return;
      }
      setResult(payload as Result);
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
        style={{ ...border, background: "var(--paper)", color: "var(--ink)" }}
      />

      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={run}
          disabled={busy}
          className="rounded-md px-4 py-2 text-[15px] font-medium disabled:opacity-50 bg-accent text-paper"
        >
          {busy ? "Auditing…" : "Run audit"}
        </button>
        <label
          className="cursor-pointer rounded-md border px-3 py-2 text-[14px]"
          style={border}
        >
          Upload CSV
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={onFile}
            className="hidden"
          />
        </label>
      </div>

      {error ? (
        <p className="rounded border-l-2 py-2 pl-3 text-[14px] border-danger bg-caution-soft text-danger">
          {error}
        </p>
      ) : null}

      {s ? (
        <>
          {s.truncated ? (
            <p className="rounded border-l-2 py-2 pl-3 text-[14px] border-caution bg-caution-soft text-caution">
              Time budget reached: {s.items} of {s.submitted} lines were priced.
              The totals below cover only those lines. Split the catalogue to
              price the rest.
            </p>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              [
                "Entered value",
                money(s.entered_value),
                s.truncated
                  ? `${s.items} of ${s.submitted} lines`
                  : `${s.items} lines`,
              ],
              [
                "Duty and fees",
                money(s.duty),
                `${s.effective_rate_pct}% effective`,
              ],
              [
                "Potentially refundable",
                money(s.potentially_refundable),
                "IEEPA, struck down",
              ],
              [
                "Needs review",
                String(s.needs_scope_review + s.unclassified),
                "scope or classification",
              ],
            ].map(([label, value, sub]) => (
              <div
                key={label}
                className="rounded-lg border p-4"
                style={{ ...border, background: "var(--surface)" }}
              >
                <div className="text-[12px] uppercase tracking-wide text-muted">
                  {label}
                </div>
                <div className="tabular mt-1 text-2xl font-semibold">
                  {value}
                </div>
                <div className="text-[12px] text-muted">{sub}</div>
              </div>
            ))}
          </div>

          <div className="scroll-x">
            <table className="w-full min-w-[760px] text-[14px]">
              <thead>
                <tr
                  className="border-b text-left"
                  style={{ ...border, color: "var(--muted)" }}
                >
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
                        <a
                          href={`/hts/${l.hts}`}
                          className="hover:underline text-accent"
                        >
                          {l.hts}
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="py-2">{l.confidence ?? "—"}</td>
                    <td className="py-2">{l.country ?? "—"}</td>
                    <td className="tabular py-2 text-right">
                      {l.entered_value !== undefined
                        ? money(l.entered_value)
                        : "—"}
                    </td>
                    <td className="tabular py-2 text-right">
                      {l.duty !== undefined ? money(l.duty) : "—"}
                    </td>
                    <td className="tabular py-2 text-right">
                      {l.effective_rate_pct !== undefined
                        ? `${l.effective_rate_pct}%`
                        : "—"}
                    </td>
                    <td className="py-2 pl-3 text-[12px] text-muted">
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

          <div className="flex flex-wrap items-end gap-3 border-t pt-5 border-border">
            {signedIn ? (
              <>
                <label className="flex flex-col gap-1.5">
                  <span className="lbl">Save as</span>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Autumn range, China"
                    className="border px-3 py-2 text-[14px] sm:w-72"
                    style={{
                      ...border,
                      background: "var(--surface)",
                      color: "var(--ink)",
                    }}
                  />
                </label>
                <button
                  disabled={saving}
                  onClick={async () => {
                    setSaving(true);
                    setSaveError(null);
                    const priced = result!.lines.filter((l) => !l.error);
                    const res = await saveCatalogueAction(
                      name,
                      priced.map((l) => ({
                        sku: l.sku,
                        description: l.description,
                        country: l.country ?? "",
                        value: l.entered_value ?? 0,
                        hts: l.hts,
                        confidence: l.confidence,
                        duty: l.duty,
                        effective_rate_pct: l.effective_rate_pct,
                        refundable: l.refundable,
                        scope_unverified: l.scope_unverified,
                      })),
                    );
                    if (res.error) {
                      setSaveError(res.error);
                      setSaving(false);
                      return;
                    }
                    router.push(`/catalogues/${res.id}`);
                  }}
                  className="px-4 py-2 text-[14px] font-medium disabled:opacity-60 bg-accent text-on-accent"
                >
                  {saving ? "Saving…" : "Save and watch these codes"}
                </button>
                <button
                  onClick={() => downloadCsv(result!.lines)}
                  className="px-4 py-2 text-[14px] font-medium"
                  style={{ ...border, borderWidth: 1, borderStyle: "solid" }}
                >
                  Export CSV
                </button>
              </>
            ) : (
              <p className="text-[14px] text-muted">
                <a
                  href="/signup"
                  className="font-medium hover:underline text-accent"
                >
                  Create a free account
                </a>{" "}
                to save this catalogue — every code in it is then watched, and
                you are told when a tariff action names one.
              </p>
            )}
          </div>

          {saveError ? (
            <p className="text-[13px] text-danger">{saveError}</p>
          ) : null}

          <p className="text-[13px] text-muted">
            Classifications are ranked from CBP ruling precedent. Confirm
            anything marked low confidence, and anything flagged for scope
            review, before you file — the reasonable-care duty stays with the
            importer of record.
          </p>
        </>
      ) : null}
    </div>
  );
}
