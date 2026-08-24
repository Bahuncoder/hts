import { API_BASE, money2, search, type Quote } from "@/lib/api";
import { Card, HtsLink, Note, Stat } from "@/components/ui";

export const metadata = {
  title: "US import duty calculator — full landed duty by HTS code",
  description:
    "Compute US import duty including Section 232, Section 301, MPF and HMF, with the legal authority for every line.",
};

export const dynamic = "force-dynamic";

async function quote(hts: string, country: string, value: number): Promise<Quote | null> {
  try {
    const res = await fetch(`${API_BASE}/api/quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hts, country, value }),
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()) as Quote;
  } catch {
    return null;
  }
}

export default async function CalculatorPage({
  searchParams,
}: {
  searchParams: Promise<{ hts?: string; country?: string; value?: string; q?: string }>;
}) {
  const sp = await searchParams;
  const country = sp.country || "China";
  const value = Number(sp.value || 10000);
  const result = sp.hts ? await quote(sp.hts, country, value) : null;
  const matches = sp.q ? await search(sp.q) : null;

  return (
    <div className="space-y-8">
      <div className="max-w-2xl space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Import duty calculator</h1>
        <p style={{ color: "var(--muted)" }}>
          The full stack, not just the MFN rate: trade remedies, merchandise
          processing fee and harbor maintenance fee, each traced to its authority.
        </p>
      </div>

      <form action="/calculator" className="grid max-w-3xl gap-3 sm:grid-cols-[1fr_auto_auto_auto]">
        <input name="hts" defaultValue={sp.hts ?? ""} placeholder="6109.10.00.12"
          className="rounded-md border px-3 py-2 text-[15px]"
          style={{ borderColor: "var(--border)", background: "var(--bg)", color: "var(--ink)" }} />
        <input name="country" defaultValue={country} placeholder="China"
          className="rounded-md border px-3 py-2 text-[15px] sm:w-36"
          style={{ borderColor: "var(--border)", background: "var(--bg)", color: "var(--ink)" }} />
        <input name="value" type="number" defaultValue={value} min={1}
          className="tabular rounded-md border px-3 py-2 text-[15px] sm:w-32"
          style={{ borderColor: "var(--border)", background: "var(--bg)", color: "var(--ink)" }} />
        <button className="rounded-md px-4 py-2 text-[15px] font-medium"
          style={{ background: "var(--accent)", color: "var(--bg)" }}>
          Calculate
        </button>
      </form>

      <form action="/calculator" className="flex max-w-2xl gap-2">
        <input name="q" defaultValue={sp.q ?? ""} placeholder="Don't know the code? Search descriptions…"
          className="min-w-0 flex-1 rounded-md border px-3 py-2 text-[14px]"
          style={{ borderColor: "var(--border)", background: "var(--bg)", color: "var(--ink)" }} />
        <button className="rounded-md border px-3 py-2 text-[14px]" style={{ borderColor: "var(--border)" }}>
          Search
        </button>
      </form>

      {matches?.results?.length ? (
        <Card>
          <div className="text-[12px] uppercase tracking-wide" style={{ color: "var(--muted)" }}>
            Matching codes
          </div>
          <ul className="mt-2 space-y-1.5 text-[14px]">
            {matches.results.slice(0, 8).map((r) => (
              <li key={r.hts}>
                <a href={`/calculator?hts=${r.hts}&country=${encodeURIComponent(country)}&value=${value}`}
                   className="tabular font-medium hover:underline" style={{ color: "var(--accent)" }}>
                  {r.hts}
                </a>{" "}
                <span style={{ color: "var(--muted)" }}>{r.description}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {result ? (
        <>
          <div className="grid gap-5 sm:grid-cols-3">
            <Card><Stat label="Total duty and fees" value={money2(result.total_duty)} /></Card>
            <Card><Stat label="Effective rate" value={`${result.effective_rate_pct}%`} /></Card>
            <Card><Stat label="Landed cost" value={money2(result.landed_cost)} sub={`on ${money2(result.entered_value)} entered`} /></Card>
          </div>

          <div className="scroll-x">
            <table className="w-full min-w-[520px] text-[14px]">
              <thead>
                <tr className="border-b text-left" style={{ borderColor: "var(--border)", color: "var(--muted)" }}>
                  <th className="py-2 font-medium">Component</th>
                  <th className="py-2 text-right font-medium">Rate</th>
                  <th className="py-2 text-right font-medium">Amount</th>
                  <th className="py-2 pl-4 font-medium">Authority</th>
                </tr>
              </thead>
              <tbody>
                {result.components.map((c) => (
                  <tr key={c.label} className="border-b" style={{ borderColor: "var(--border)" }}>
                    <td className="py-2">{c.label}</td>
                    <td className="tabular py-2 text-right">{c.rate_pct !== null ? `${c.rate_pct}%` : "—"}</td>
                    <td className="tabular py-2 text-right">{money2(c.amount)}</td>
                    <td className="py-2 pl-4 text-[13px]" style={{ color: "var(--muted)" }}>{c.authority}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="text-[14px]">
            Full detail for this code: <HtsLink code={result.hts} />
          </p>

          {result.refundable_amount > 0 ? (
            <Note>
              {money2(result.refundable_amount)} of this derives from IEEPA
              provisions the Supreme Court invalidated on 20 February 2026 and may
              be recoverable by protest.
            </Note>
          ) : null}
          {result.warnings.map((w) => <Note key={w}>{w}</Note>)}
        </>
      ) : sp.hts ? (
        <Note>No result for that code. Check it is a 10-digit statistical line.</Note>
      ) : null}
    </div>
  );
}
