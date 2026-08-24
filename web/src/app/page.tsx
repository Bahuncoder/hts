import Link from "next/link";
import { getHealth } from "@/lib/api";
import { Card, Stat } from "@/components/ui";

export const revalidate = 900;

export default async function Home() {
  const health = await getHealth();
  const c = health?.counts ?? {};

  return (
    <div className="space-y-14">
      <section className="max-w-3xl space-y-5">
        <h1 className="text-4xl font-semibold tracking-tight">
          Know what your imports actually cost.
        </h1>
        <p className="text-lg" style={{ color: "var(--muted)" }}>
          Most duty calculators ask for an HTS code you don&rsquo;t have, then quote a
          rate that ignores the trade remedies stacked on top of it. Tariffwise
          classifies your goods against 200,000 CBP rulings and computes the full
          duty stack — Section 232, Section 301, MPF and HMF — with the authority
          for every line.
        </p>
        <div className="flex flex-wrap gap-3">
          <Link
            href="/classify"
            className="rounded-md px-4 py-2 text-[15px] font-medium"
            style={{ background: "var(--accent)", color: "var(--bg)" }}
          >
            Classify a product
          </Link>
          <Link
            href="/audit"
            className="rounded-md border px-4 py-2 text-[15px] font-medium"
            style={{ borderColor: "var(--border)" }}
          >
            Audit a catalogue
          </Link>
        </div>
      </section>

      <section className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        <Card><Stat label="HTS lines" value={(c.hts ?? 0).toLocaleString()} sub={`${health?.hts_edition ?? ""} edition`} /></Card>
        <Card><Stat label="CBP rulings indexed" value={(c.ruling ?? 0).toLocaleString()} sub="classification precedent" /></Card>
        <Card><Stat label="Chapter 99 rules" value={(c.ch99_rule ?? 0).toLocaleString()} sub="trade remedies parsed" /></Card>
        <Card><Stat label="Scoped product codes" value={(c.ch99_scope ?? 0).toLocaleString()} sub="from the U.S. Notes" /></Card>
      </section>

      <section className="space-y-4">
        <h2 className="text-2xl font-semibold tracking-tight">
          Why other calculators get this wrong
        </h2>
        <div className="grid gap-5 md:grid-cols-3">
          <Card>
            <h3 className="font-medium">Scope lives in a PDF</h3>
            <p className="mt-2 text-[14px]" style={{ color: "var(--muted)" }}>
              487 of 565 Chapter 99 remedy rules carry no machine-readable product
              scope. They defer to the Chapter 99 U.S. Notes, published only as
              prose. Tools built on the JSON feed alone are guessing which goods a
              tariff covers. We parse the Notes.
            </p>
          </Card>
          <Card>
            <h3 className="font-medium">Suspended tariffs still print</h3>
            <p className="mt-2 text-[14px]" style={{ color: "var(--muted)" }}>
              Heading 9903.88.16 appears in the schedule at 15% and is suspended.
              Applying it overstates duty on affected goods by fifteen points. We
              read the suspension footnotes.
            </p>
          </Card>
          <Card>
            <h3 className="font-medium">Struck-down duties are money owed to you</h3>
            <p className="mt-2 text-[14px]" style={{ color: "var(--muted)" }}>
              The Supreme Court invalidated the IEEPA tariffs in February 2026.
              Those provisions are still in the schedule. We report them separately
              as potentially refundable rather than as duty owed.
            </p>
          </Card>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-2xl font-semibold tracking-tight">Start somewhere</h2>
        <ul className="grid gap-2 text-[15px] sm:grid-cols-2">
          {[
            ["/classify", "Describe a product, get candidate HTS codes with the rulings behind them"],
            ["/calculator", "Compute the full landed duty for a code and country of origin"],
            ["/changes", "See every tariff action published in the last 90 days"],
            ["/audit", "Upload a catalogue and price your whole duty exposure"],
          ].map(([href, label]) => (
            <li key={href}>
              <Link href={href} className="hover:underline" style={{ color: "var(--accent)" }}>
                {label}
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
