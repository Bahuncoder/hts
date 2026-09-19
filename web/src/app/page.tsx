import Link from "next/link";
import { getHealth } from "@/lib/api";
import { Card, Note, Stat } from "@/components/ui";

export const revalidate = 900;

export default async function Home() {
  const health = await getHealth();
  // Counts are absent when the engine is unreachable and also when it answers
  // without them. Either way the figure is unknown, which is not the same as
  // zero, so it is shown as unavailable.
  const c = health.ok ? health.data.counts : undefined;
  const count = (n: number | undefined) =>
    typeof n === "number" ? n.toLocaleString() : "unavailable";
  const edition = health.ok ? health.data.hts_edition : undefined;

  return (
    <div className="space-y-14">
      <section className="max-w-3xl space-y-5">
        <h1 className="text-4xl font-semibold tracking-tight">
          Know what your imports actually cost.
        </h1>
        <p className="text-lg text-muted">
          Most duty calculators ask for an HTS code you don&rsquo;t have, then
          quote a rate that ignores the trade remedies stacked on top of it.
          HTSDesk classifies your goods against 200,000 CBP rulings and computes
          the full duty stack — Section 232, Section 301, MPF and HMF — with the
          authority for every line.
        </p>
        <div className="flex flex-wrap gap-3">
          <Link
            href="/classify"
            className="rounded-md px-4 py-2 text-[15px] font-medium bg-accent text-paper"
          >
            Classify a product
          </Link>
          <Link
            href="/audit"
            className="rounded-md border px-4 py-2 text-[15px] font-medium border-border"
          >
            Audit a catalogue
          </Link>
        </div>
      </section>

      {!c ? (
        <Note role="status">
          Live dataset figures are temporarily unavailable. The tools below
          still work if you try them.
        </Note>
      ) : null}

      <section className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <Stat
            label="HTS lines"
            value={count(c?.hts)}
            sub={edition ? `${edition} edition` : "edition not reported"}
          />
        </Card>
        <Card>
          <Stat
            label="CBP rulings indexed"
            value={count(c?.ruling)}
            sub="classification precedent"
          />
        </Card>
        <Card>
          <Stat
            label="Chapter 99 rules"
            value={count(c?.ch99_rule)}
            sub="trade remedies parsed"
          />
        </Card>
        <Card>
          <Stat
            label="Scoped product codes"
            value={count(c?.ch99_scope)}
            sub="from the U.S. Notes"
          />
        </Card>
      </section>

      <section className="space-y-4">
        <h2 className="text-2xl font-semibold tracking-tight">
          Why other calculators get this wrong
        </h2>
        <div className="grid gap-5 md:grid-cols-3">
          <Card>
            <h3 className="font-medium">Scope lives in a PDF</h3>
            <p className="mt-2 text-[14px] text-muted">
              487 of 565 Chapter 99 remedy rules carry no machine-readable
              product scope. They defer to the Chapter 99 U.S. Notes, published
              only as prose. Tools built on the JSON feed alone are guessing
              which goods a tariff covers. We parse the Notes.
            </p>
          </Card>
          <Card>
            <h3 className="font-medium">Suspended tariffs still print</h3>
            <p className="mt-2 text-[14px] text-muted">
              Heading 9903.88.16 appears in the schedule at 15% and is
              suspended. Applying it overstates duty on affected goods by
              fifteen points. We read the suspension footnotes.
            </p>
          </Card>
          <Card>
            <h3 className="font-medium">
              Struck-down duties are shown separately
            </h3>
            <p className="mt-2 text-[14px] text-muted">
              The Supreme Court invalidated the IEEPA tariffs in February 2026,
              but those provisions are still in the schedule. We keep them out
              of the duty total and show a scenario estimate: if IEEPA duty was
              paid on an entry like this, about that much may be recoverable.
              Actual eligibility depends on the entries you filed, their
              liquidation status and CBP&rsquo;s refund process; the figure is
              not a claim amount.
            </p>
          </Card>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-2xl font-semibold tracking-tight">
          Start somewhere
        </h2>
        <ul className="grid gap-2 text-[15px] sm:grid-cols-2">
          {[
            [
              "/classify",
              "Describe a product, get candidate HTS codes with the rulings behind them",
            ],
            [
              "/calculator",
              "Compute the full landed duty for a code and country of origin",
            ],
            [
              "/changes",
              "See every tariff action published in the last 90 days",
            ],
            ["/audit", "Upload a catalogue and price your whole duty exposure"],
          ].map(([href, label]) => (
            <li key={href}>
              <Link href={href} className="hover:underline text-accent">
                {label}
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
