import Link from "next/link";
import { getHealth } from "@/lib/api";
import { Card } from "@/components/ui";
import DutyExampleCard from "@/components/DutyExampleCard";
import ToolsGrid from "@/components/ToolsGrid";

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
  const edition = health.ok ? health.data.hts_edition : undefined;

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
        <DutyExampleCard
          heading="Inside a China-origin estimate"
          lines={[["Base duty (HTSUS Column 1)", "$1,650.00"], ["Section 301 List 3", "$750.00"], ["Processing & harbor fees", "$47.14"]]}
          edition={edition}
        />
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

      <ToolsGrid heading="Built for the layers China adds." tools={tools} />

      <div className="relative left-1/2 right-1/2 mx-[-50vw] w-screen bg-deep">
        <div className="mx-auto max-w-7xl px-5 py-12 sm:px-8 sm:py-16">
          <section className="panel-deep grid gap-8 p-6 sm:p-8 md:grid-cols-2" aria-labelledby="why-title">
            <div>
              <p className="eyebrow">Why China needs its own read</p>
              <h2 id="why-title" className="serif mt-3 text-3xl tracking-tight">Four Section 301 lists. One IEEPA action. Real gaps.</h2>
              <p className="mt-4 max-w-md text-sm leading-relaxed text-deep-muted">
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
                  <div><dt className="lbl">HTS lines</dt><dd className="mono mt-2 text-3xl sm:text-4xl font-semibold">{counts.hts?.toLocaleString()}</dd></div>
                  <div><dt className="lbl">Chapter 99 rules</dt><dd className="mono mt-2 text-3xl sm:text-4xl font-semibold">{counts.ch99_rule?.toLocaleString()}</dd></div>
                  <div><dt className="lbl">Scoped code links</dt><dd className="mono mt-2 text-3xl sm:text-4xl font-semibold">{counts.ch99_scope?.toLocaleString()}</dd></div>
                  <div><dt className="lbl">CBP rulings</dt><dd className="mono mt-2 text-3xl sm:text-4xl font-semibold">{counts.ruling?.toLocaleString()}</dd></div>
                </dl>
              ) : null}
              <p className={counts ? "mt-7 text-xs text-deep-muted" : "text-sm leading-relaxed text-deep-muted"}>Sources: USITC, CBP, and the Federal Register.</p>
            </div>
          </section>
        </div>
      </div>

      <Card className="space-y-2">
        <h2 className="text-[18px] font-semibold">What we do not do</h2>
        <p className="text-[13.5px] leading-relaxed text-muted">
          We do not file entries, and we are not your customs broker. HTSDesk finds candidate
          classifications, shows the CBP rulings behind them, and prices the duty &mdash; your broker
          signs off, and confirms any refund or protest timing before you rely on it.
        </p>
      </Card>
    </div>
  );
}
