import Link from "next/link";
import { getHealth } from "@/lib/api";

export const revalidate = 900;

const tools = [
  { step: "01", title: "Find your product code", description: "Describe your goods in plain words. Compare HTS candidates with the CBP rulings that support them.", href: "/classify", action: "Classify a product" },
  { step: "02", title: "Understand the duty", description: "See base duty, trade remedies, and fees together, with the assumptions behind your estimate.", href: "/calculator", action: "Calculate duty" },
  { step: "03", title: "Review your whole catalogue", description: "Import your product list, focus on the lines that need attention, and save your codes to monitor.", href: "/audit", action: "Audit a catalogue" },
];

export default async function Home() {
  const health = await getHealth();
  const counts = health.ok ? health.data.counts : undefined;
  const edition = health.ok ? health.data.hts_edition : undefined;
  return (
    <div className="space-y-14 sm:space-y-20">
      <section className="hero">
        <div>
          <p className="eyebrow mb-5">Clarity for every import</p>
          <h1 className="hero-title">Know the code.<br />Understand the cost.</h1>
          <p className="mt-6 max-w-xl text-base leading-relaxed text-muted sm:text-lg">
            Go from a product description to a duty estimate you can explore.
            HTS codes, trade remedies, and the evidence behind them — in one workspace.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Link href="/audit" className="btn btn-primary">Audit your catalogue <span aria-hidden="true">→</span></Link>
            <Link href="/classify" className="btn btn-secondary">Classify one product</Link>
          </div>
          <p className="mt-4 text-xs text-faint">Free while in beta. Try the tools without an account; a free account saves your catalogues and watches your codes.</p>
        </div>
        <div className="hero-example" aria-label="Illustrative duty breakdown, not a live quote">
          <div className="flex items-center justify-between border-b border-border px-6 py-4">
            <span className="lbl">Inside your duty estimate</span><span className="rounded bg-sunk px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted">Example</span>
          </div>
          <div className="p-6 sm:p-8">
            <div className="flex items-start justify-between gap-4">
              <div><p className="text-sm font-medium">Cotton T-shirt</p><p className="mono mt-1 text-xs text-faint">China · $10,000 entered value</p></div>
              <span className="rounded-full bg-caution-soft px-2.5 py-1 text-xs text-caution-ink">Review needed</span>
            </div>
            <div className="mt-7 space-y-4 text-sm">
              {[["Base duty", "$1,650.00"], ["Trade remedy", "$750.00"], ["Processing & harbor fees", "$47.14"]].map(([label, amount]) => (
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

      <section aria-labelledby="workflow-title">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div><p className="eyebrow">From question to decision</p><h2 id="workflow-title" className="serif mt-2 text-3xl tracking-tight">A clearer way to work.</h2></div>
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

      <section className="panel grid gap-8 p-6 sm:p-8 md:grid-cols-2" aria-labelledby="evidence-title">
        <div><p className="eyebrow">Evidence you can inspect</p><h2 id="evidence-title" className="serif mt-3 text-3xl tracking-tight">Every figure needs context.</h2><p className="mt-4 max-w-md text-sm leading-relaxed text-muted">Follow classifications back to ruling precedent. Inspect duty components and assumptions. Keep incomplete estimates visible while you review the details with your broker.</p></div>
        <div className="self-center"><dl className="grid grid-cols-2 gap-x-5 gap-y-7">
          {[["HTS lines", counts?.hts], ["CBP rulings", counts?.ruling], ["Chapter 99 rules", counts?.ch99_rule], ["Scoped code links", counts?.ch99_scope]].map(([label, count]) => <div key={String(label)}><dt className="lbl">{label}</dt><dd className="mono mt-2 text-xl">{typeof count === "number" ? count.toLocaleString() : "Unavailable"}</dd></div>)}
        </dl>
          <p className="mt-7 text-xs text-faint">{edition ? `Reference edition: ${edition}.` : "Live reference figures are temporarily unavailable."} Sources: USITC, CBP, and the Federal Register.</p>
        </div>
      </section>
    </div>
  );
}
