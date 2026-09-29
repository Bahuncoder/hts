import Link from "next/link";
import { getHealth } from "@/lib/api";
import { Card } from "@/components/ui";

export const revalidate = 900;

export const metadata = {
  title: "China tariff & duty calculator — Section 301, IEEPA, HTS classification",
  description:
    "Classify China-origin goods, price Section 301 and IEEPA duty together, and check entries you already filed for struck-down IEEPA duty that may be refundable.",
};

const tools = [
  { step: "01", title: "Classify a China-origin product", description: "Describe your goods in plain words. Compare HTS candidates with the CBP rulings that support them, and see every Section 301/IEEPA heading that could apply.", href: "/classify", action: "Classify a product" },
  { step: "02", title: "Price the full duty stack", description: "Base duty, Section 301, IEEPA, antidumping/countervailing orders and fees, together — with the assumptions and authority behind each figure.", href: "/calculator", action: "Calculate duty" },
  { step: "03", title: "Audit your whole catalogue", description: "Import your product list, see which lines carry unresolved China-specific remedies, and save the codes you want monitored for the next tariff action.", href: "/audit", action: "Audit a catalogue" },
];

export default async function ChinaTariffsPage() {
  const health = await getHealth();
  const counts = health.ok ? health.data.counts : undefined;

  return (
    <div className="space-y-14 sm:space-y-20">
      <section className="hero">
        <div>
          <p className="eyebrow mb-5">For importers sourcing from China</p>
          <h1 className="hero-title">China duty is layered.<br />See every layer.</h1>
          <p className="mt-6 max-w-xl text-base leading-relaxed text-muted sm:text-lg">
            A China-origin entry can stack base duty, a Section 301 List 1&ndash;4 heading, and an
            IEEPA tariff &mdash; and one of those layers was struck down by the Supreme Court on
            2026-02-20. Classify the product, price every layer with its authority cited, and check
            whether duty you already paid is now recoverable.
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-3">
            <Link href="/audit" className="btn btn-primary">Audit your catalogue <span aria-hidden="true">→</span></Link>
            <Link href="/classify" className="btn btn-secondary">Classify one product</Link>
          </div>
          <p className="mt-4 max-w-xl text-[14px] leading-relaxed text-muted">
            Try the tools without an account.{" "}
            <Link href="/refund-check" className="font-medium text-accent hover:underline">Already filed entries?</Link>
          </p>
        </div>
        <div className="hero-example" aria-label="Illustrative duty breakdown, not a live quote">
          <div className="flex items-center justify-between border-b border-border px-6 py-4">
            <span className="lbl">Inside a China-origin estimate</span><span className="rounded bg-sunk px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted">Example</span>
          </div>
          <div className="p-6 sm:p-8">
            <div className="flex items-start justify-between gap-4">
              <div><p className="text-sm font-medium">Cotton T-shirt</p><p className="mono mt-1 text-xs text-faint">China · $10,000 entered value</p></div>
              <span className="rounded-full bg-caution-soft px-2.5 py-1 text-xs text-caution-ink">Review needed</span>
            </div>
            <div className="mt-7 space-y-4 text-sm">
              {[["Base duty (HTSUS Column 1)", "$1,650.00"], ["Section 301 List 3", "$750.00"], ["Processing & harbor fees", "$47.14"]].map(([label, amount]) => (
                <div key={label} className="flex justify-between gap-3"><span className="text-muted">{label}</span><span className="mono">{amount}</span></div>
              ))}
            </div>
            <div className="mt-6 flex items-end justify-between gap-4 border-t border-rule pt-5">
              <div><p className="lbl">Illustrative subtotal</p><p className="mt-1 text-xs text-muted">Before unresolved duties</p></div>
              <p className="mono text-2xl font-medium text-accent">$2,447.14</p>
            </div>
            <p className="mt-5 rounded-md border-l-2 border-caution bg-caution-soft p-3 text-xs leading-relaxed text-caution-ink">An unresolved scope is kept visible, so you know what to confirm before relying on a figure.</p>
          </div>
          <div className="border-t border-border bg-sunk px-6 py-3 text-xs text-muted">Illustration only. Run a calculation for your goods and current data.</div>
        </div>
      </section>

      <section className="panel space-y-4 p-6 sm:p-8" aria-labelledby="refund-title">
        <p className="eyebrow" style={{ color: "var(--recover)" }}>Struck-down IEEPA duty</p>
        <h2 id="refund-title" className="serif text-3xl tracking-tight">Already paid IEEPA duty? Check it.</h2>
        <p className="max-w-2xl text-[15px] leading-relaxed text-muted">
          The Supreme Court held on 2026-02-20 that IEEPA (headings 9903.01/9903.02) confers no
          tariff authority. Those headings are still printed in the schedule, so a fresh quote still
          shows the duty &mdash; separately, as a scenario estimate of what may be recoverable, never
          as duty owed. <Link href="/refund-check" className="font-medium text-accent hover:underline">Entry Refund Check</Link> lets
          you tell us what you actually paid and when, and adds CBP&rsquo;s Post Summary Correction and
          protest timing windows on top &mdash; available on Starter and Growth.
        </p>
        <Link href="/refund-check" className="btn btn-secondary w-fit">Check your entries</Link>
      </section>

      <section aria-labelledby="workflow-title">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div><p className="eyebrow">From question to decision</p><h2 id="workflow-title" className="serif mt-2 text-3xl tracking-tight">Built for the layers China adds.</h2></div>
          <Link href="/changes" className="text-sm font-medium text-accent hover:underline">Explore tariff changes <span aria-hidden="true">↗</span></Link>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          {tools.map((tool) => <Link key={tool.href} href={tool.href} className="tool-card">
            <span className="mono text-xs text-faint">{tool.step} /</span>
            <h3 className="serif text-2xl leading-tight tracking-tight">{tool.title}</h3>
            <p className="text-sm leading-relaxed text-muted">{tool.description}</p>
            <span className="tool-arrow">{tool.action} <span aria-hidden="true">→</span></span>
          </Link>)}
        </div>
      </section>

      <section className="panel grid gap-8 p-6 sm:p-8 md:grid-cols-2" aria-labelledby="why-title">
        <div>
          <p className="eyebrow">Why China needs its own read</p>
          <h2 id="why-title" className="serif mt-3 text-3xl tracking-tight">Four Section 301 lists. One IEEPA action. Real gaps.</h2>
          <p className="mt-4 max-w-md text-sm leading-relaxed text-muted">
            Section 301 List 1&ndash;4 product scope is defined in prose in the Chapter 99 U.S.
            Notes, not a clean lookup table &mdash; we parse it directly rather than maintain a
            separate list. Where a heading&rsquo;s scope can&rsquo;t be resolved mechanically, it is
            excluded from the total and flagged, not guessed at, so a figure is never confidently
            wrong.
          </p>
        </div>
        <div className="self-center">
          {counts ? (
            <dl className="grid grid-cols-2 gap-x-5 gap-y-7">
              <div><dt className="lbl">HTS lines</dt><dd className="mono mt-2 text-xl">{counts.hts?.toLocaleString()}</dd></div>
              <div><dt className="lbl">Chapter 99 rules</dt><dd className="mono mt-2 text-xl">{counts.ch99_rule?.toLocaleString()}</dd></div>
              <div><dt className="lbl">Scoped code links</dt><dd className="mono mt-2 text-xl">{counts.ch99_scope?.toLocaleString()}</dd></div>
              <div><dt className="lbl">CBP rulings</dt><dd className="mono mt-2 text-xl">{counts.ruling?.toLocaleString()}</dd></div>
            </dl>
          ) : null}
          <p className={counts ? "mt-7 text-xs text-faint" : "text-sm leading-relaxed text-muted"}>Sources: USITC, CBP, and the Federal Register.</p>
        </div>
      </section>

      <Card className="space-y-2">
        <h2 className="text-[15px] font-semibold">What we do not do</h2>
        <p className="text-[13.5px] leading-relaxed text-muted">
          We do not file entries, and we are not your customs broker. HTSDesk finds candidate
          classifications, shows the CBP rulings behind them, and prices the duty &mdash; your broker
          signs off, and confirms any refund or protest timing before you rely on it.
        </p>
      </Card>
    </div>
  );
}
