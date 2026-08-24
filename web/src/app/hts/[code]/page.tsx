import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getHts, money2 } from "@/lib/api";
import { Badge, Card, Note, Stat } from "@/components/ui";

export const revalidate = 3600;

type Props = { params: Promise<{ code: string }>; searchParams: Promise<{ country?: string }> };

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { code } = await params;
  const { country = "China" } = await searchParams;
  const d = await getHts(code, country);
  if (!d) return { title: `HTS ${code}` };
  const rate = d.quote ? `${d.quote.effective_rate_pct}%` : d.rates.general;
  return {
    title: `HTS ${d.hts} — ${d.description.slice(0, 60)} | duty rate from ${country}`,
    description:
      `Import duty for HTS ${d.hts}: ${d.description.slice(0, 90)}. ` +
      `Effective rate from ${country} is ${rate}, including trade remedies, MPF and HMF.`,
    alternates: { canonical: `/hts/${d.hts}` },
  };
}

const COUNTRIES = ["China", "Vietnam", "Mexico", "Canada", "India", "Germany", "Japan", "Taiwan"];

export default async function HtsPage({ params, searchParams }: Props) {
  const { code } = await params;
  const { country = "China" } = await searchParams;
  const d = await getHts(code, country);
  if (!d) notFound();

  const q = d.quote;

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="tabular text-3xl font-semibold tracking-tight">{d.hts}</h1>
          {d.is_leaf ? <Badge tone="good">statistical line</Badge> : <Badge>heading</Badge>}
        </div>
        <p className="text-lg">{d.description}</p>
        <p className="text-[13px]" style={{ color: "var(--muted)" }}>{d.full_path}</p>
      </div>

      <nav className="flex flex-wrap gap-2 text-[13px]">
        <span style={{ color: "var(--muted)" }}>Origin:</span>
        {COUNTRIES.map((c) => (
          <a key={c} href={`/hts/${d.hts}?country=${encodeURIComponent(c)}`}
             className="rounded border px-2 py-0.5 hover:underline"
             style={{
               borderColor: c === country ? "var(--accent)" : "var(--border)",
               color: c === country ? "var(--accent)" : "var(--muted)",
             }}>
            {c}
          </a>
        ))}
      </nav>

      {q ? (
        <>
          <div className="grid gap-5 sm:grid-cols-3">
            <Card><Stat label={`Effective rate from ${country}`} value={`${q.effective_rate_pct}%`} /></Card>
            <Card><Stat label="Duty on $10,000" value={money2(q.total_duty)} sub="including MPF and HMF" /></Card>
            <Card>
              <Stat
                label="Potentially refundable"
                value={money2(q.refundable_amount)}
                sub={q.refundable_amount > 0 ? "IEEPA — struck down" : "none identified"}
                tone={q.refundable_amount > 0 ? "warn" : undefined}
              />
            </Card>
          </div>

          <section className="space-y-3">
            <h2 className="text-xl font-semibold tracking-tight">Duty stack</h2>
            <div className="scroll-x">
              <table className="w-full min-w-[520px] text-[14px]">
                <thead>
                  <tr className="border-b text-left" style={{ borderColor: "var(--border)", color: "var(--muted)" }}>
                    <th className="py-2 font-medium">Component</th>
                    <th className="py-2 text-right font-medium">Rate</th>
                    <th className="py-2 text-right font-medium">On $10,000</th>
                    <th className="py-2 pl-4 font-medium">Authority</th>
                  </tr>
                </thead>
                <tbody>
                  {q.components.map((c) => (
                    <tr key={c.label} className="border-b" style={{ borderColor: "var(--border)" }}>
                      <td className="py-2">{c.label}</td>
                      <td className="tabular py-2 text-right">{c.rate_pct !== null ? `${c.rate_pct}%` : "—"}</td>
                      <td className="tabular py-2 text-right">{money2(c.amount)}</td>
                      <td className="py-2 pl-4 text-[13px]" style={{ color: "var(--muted)" }}>{c.authority}</td>
                    </tr>
                  ))}
                  <tr className="font-semibold">
                    <td className="py-2">Total</td>
                    <td className="tabular py-2 text-right">{q.effective_rate_pct}%</td>
                    <td className="tabular py-2 text-right">{money2(q.total_duty)}</td>
                    <td />
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          {q.refundable.length ? (
            <Note>
              {q.refundable.length} provision(s) here derive from IEEPA, which the
              Supreme Court invalidated on 20 February 2026. Duty paid under them
              may be recoverable by protest — {money2(q.refundable_amount)} on a
              $10,000 entry.
            </Note>
          ) : null}

          {q.warnings.map((w) => <Note key={w}>{w}</Note>)}
        </>
      ) : (
        <Note>
          This is a heading rather than a 10-digit statistical line, so no duty is
          computed. Choose a statistical line beneath it.
        </Note>
      )}

      {d.trade_remedies.length ? (
        <section className="space-y-3">
          <h2 className="text-xl font-semibold tracking-tight">Trade remedies covering this code</h2>
          <div className="space-y-2">
            {d.trade_remedies.map((r) => (
              <Card key={r.heading}>
                <div className="flex flex-wrap items-center gap-3 text-[14px]">
                  <span className="tabular font-medium">{r.heading}</span>
                  {r.suspended ? <Badge tone="bad">suspended</Badge> : <Badge tone="warn">in force</Badge>}
                  <span style={{ color: "var(--muted)" }}>
                    {JSON.parse(r.countries || "[]").join(", ") || "all origins"}
                  </span>
                  <span className="tabular ml-auto">{r.raw_rate}</span>
                </div>
                <p className="mt-1 text-[12px]" style={{ color: "var(--muted)" }}>
                  Scope from Chapter 99 U.S. Note {r.note}
                  {r.effective_from ? ` · effective ${r.effective_from}` : ""}
                </p>
              </Card>
            ))}
          </div>
        </section>
      ) : null}

      {d.rulings.length ? (
        <section className="space-y-3">
          <h2 className="text-xl font-semibold tracking-tight">CBP rulings on this code</h2>
          <div className="space-y-1.5">
            {d.rulings.map((r) => (
              <div key={r.ruling_number} className="clamp-1 text-[14px]">
                <a href={r.url} target="_blank" rel="noopener noreferrer"
                   className="font-medium hover:underline" style={{ color: "var(--accent)" }}>
                  {r.ruling_number}
                </a>{" "}
                <span className="tabular text-[12px]" style={{ color: "var(--muted)" }}>{r.ruling_date}</span>{" "}
                {r.revoked ? <Badge tone="bad">revoked</Badge> : null}{" "}
                <span style={{ color: "var(--muted)" }}>{r.subject}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
