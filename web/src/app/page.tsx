import Link from "next/link";
import { getHealth } from "@/lib/api";
import DutyExampleCard from "@/components/DutyExampleCard";
import ToolsGrid from "@/components/ToolsGrid";

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
  // Row counts only come back to a keyed caller. When they are missing the
  // block shows the sources sentence alone; "Unavailable" four times over
  // would read as a fault, not as figures we choose not to show.
  const figures = ([
    ["HTS lines", counts?.hts],
    ["CBP rulings", counts?.ruling],
    ["Chapter 99 rules", counts?.ch99_rule],
    ["Scoped code links", counts?.ch99_scope],
  ] as [string, number | undefined][]).filter(([, n]) => typeof n === "number");
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
          <div className="mt-7 flex flex-wrap items-center gap-3">
            <Link href="/audit" className="btn btn-primary">Audit your catalogue <span aria-hidden="true">→</span></Link>
            <Link href="/classify" className="btn btn-secondary">Classify one product</Link>
            <Link href="/pricing" className="inline-flex min-h-[44px] items-center rounded-full border border-border bg-accent-soft px-4 text-[14px] font-medium text-accent">Free to start</Link>
          </div>
          <p className="mt-4 max-w-xl text-[14px] leading-relaxed text-muted">Try the tools without an account; a free account saves your catalogues and watches your codes. <Link href="/pricing" className="font-medium text-accent hover:underline">See plans</Link>.</p>
          <p className="mt-2 max-w-xl text-[14px] leading-relaxed text-muted">Sourcing from China? <Link href="/china-tariffs" className="font-medium text-accent hover:underline">See how Section 301 and IEEPA duty stack, and check what may be refundable</Link>.</p>
        </div>
        <DutyExampleCard
          heading="Inside your duty estimate"
          lines={[["Base duty", "$1,650.00"], ["Trade remedy", "$750.00"], ["Processing & harbor fees", "$47.14"]]}
          edition={edition}
        />
      </section>

      <section aria-labelledby="start-title" className="grid gap-4 md:grid-cols-2">
        <h2 id="start-title" className="sr-only">Where to start</h2>
        <Link href="/classify" className="panel p-6 hover:border-accent">
          <p className="eyebrow">One product</p>
          <p className="serif mt-2 text-2xl tracking-tight">Start with its HTS code</p>
          <p className="mt-2 text-sm leading-relaxed text-muted">Describe it, compare the candidate codes, then estimate its duty.</p>
        </Link>
        <Link href="/audit" className="panel p-6 hover:border-accent">
          <p className="eyebrow">A product spreadsheet</p>
          <p className="serif mt-2 text-2xl tracking-tight">Audit your whole list</p>
          <p className="mt-2 text-sm leading-relaxed text-muted">Paste or upload it, check the products that need attention, and save the evidence.</p>
        </Link>
      </section>

      <ToolsGrid heading="A clearer way to work." tools={tools} />

      <div className="relative left-1/2 right-1/2 mx-[-50vw] w-screen bg-deep">
        <div className="mx-auto max-w-7xl px-5 py-12 sm:px-8 sm:py-16">
          <section className="panel-deep grid gap-8 p-6 sm:p-8 md:grid-cols-2" aria-labelledby="evidence-title">
            <div><p className="eyebrow">Evidence you can inspect</p><h2 id="evidence-title" className="serif mt-3 text-3xl tracking-tight">Every figure needs context.</h2><p className="mt-4 max-w-md text-sm leading-relaxed text-deep-muted">Follow classifications back to ruling precedent. Inspect duty components and assumptions. Keep incomplete estimates visible while you review the details with your broker.</p></div>
            <div className="self-center">
              {figures.length ? (
                <dl className="grid grid-cols-2 gap-x-5 gap-y-7">
                  {figures.map(([label, count]) => <div key={label}><dt className="lbl">{label}</dt><dd className="mono mt-2 text-3xl sm:text-4xl font-semibold">{(count as number).toLocaleString()}</dd></div>)}
                </dl>
              ) : null}
              <p className={`${figures.length ? "mt-7 text-xs text-deep-muted" : "text-sm leading-relaxed text-deep-muted"}`}>{edition ? `Reference edition: ${edition}.` : health.ok ? "" : "Live reference figures are temporarily unavailable."} Sources: USITC, CBP, and the Federal Register.</p>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
