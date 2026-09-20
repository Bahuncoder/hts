import { PageHeader } from "@/components/PageHeader";
import Link from "next/link";
import { getQuote, money2, search, type Quote } from "@/lib/api";
import { Card, Note, Stat } from "@/components/ui";
import { Field, RadioGroup, inputClass } from "@/components/Field";
import { ORIGINS } from "@/lib/origins";
import { FailureNotice } from "@/components/FailureNotice";
import {
  IncompleteReasons,
  RefundScenario,
  ScenarioLine,
  Assumptions,
  isComplete,
} from "@/components/QuoteFigures";

export const metadata = {
  title: "US import duty calculator — duty and fees by HTS code",
  description:
    "Estimate US import duty and fees for one entry, including Section 232, Section 301, MPF and HMF, with the legal authority for every line. A scenario estimate, not a filing.",
};

export const dynamic = "force-dynamic";

type Params = Record<string, string | string[] | undefined>;

const one = (v: string | string[] | undefined) =>
  (Array.isArray(v) ? v[0] : v) ?? undefined;

/** Accepts "10000", "10,000" and "$2,499.50". Anything else is not a value. */
function parseValue(raw: string): number | null {
  const n = Number(raw.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n > 0 && n <= 1e12 ? n : null;
}

export default async function CalculatorPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const sp = await searchParams;

  // Everything the visitor typed is kept verbatim so a failure never costs
  // them their entry.
  const hts = (one(sp.hts) ?? "").trim();
  const country = (one(sp.country) ?? "").trim();
  const rawValue = one(sp.value) ?? "10000";
  const transport = one(sp.transport) === "air" ? "air" : "sea";
  const entry = one(sp.entry) === "informal" ? "informal" : "formal";
  const program = (one(sp.program) ?? "").trim().toUpperCase().slice(0, 8);
  const rawQuantity = (one(sp.quantity) ?? "").trim();
  const quantityUnit = (one(sp.unit) ?? "").trim().slice(0, 32);
  const q = (one(sp.q) ?? "").trim();

  const scenario: Record<string, string> = {
    hts,
    country,
    value: rawValue,
    transport,
    entry,
    program,
    quantity: rawQuantity,
    unit: quantityUnit,
  };
  const href = (over: Record<string, string> = {}) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...scenario, ...over })) {
      if (v) p.set(k, v);
    }
    return `/calculator?${p}`;
  };

  // --- price the code --------------------------------------------------
  const value = parseValue(rawValue);
  const quantity = rawQuantity ? parseValue(rawQuantity) : null;
  let inputProblem: string | null = null;
  if (hts) {
    if (!country) {
      inputProblem =
        "Enter a country of origin so the right duties are applied.";
    } else if (value === null) {
      inputProblem =
        "Enter an entered value above $0, for example 10000 or 2499.50.";
    } else if (rawQuantity && quantity === null) {
      inputProblem =
        "Enter the quantity as a number above 0, for example 2500, or leave it blank.";
    }
  }
  const quote =
    hts && !inputProblem && value !== null
      ? await getQuote({
          hts,
          country,
          value,
          byVessel: transport === "sea",
          formalEntry: entry === "formal",
          preferenceProgram: program || undefined,
          quantity: quantity ?? undefined,
          quantityUnit: quantityUnit || undefined,
        })
      : null;

  // --- find a code -----------------------------------------------------
  const searchProblem =
    q && q.length < 2 ? "Type at least 2 characters to search." : null;
  const matches = q && !searchProblem ? await search(q) : null;

  return (
    <div className="space-y-8">
      <PageHeader eyebrow="Duty calculator" title="Know your duty exposure" description="Build an estimate for one customs entry. Choose the origin and shipping assumptions, then explore every duty and fee." />

      <form action="/calculator" className="panel space-y-6 p-5 sm:p-7">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field
            id="hts"
            label="HTS code"
            hint="10 digits, with or without dots."
          >
            <input
              id="hts"
              name="hts"
              defaultValue={hts}
              placeholder="6109.10.00.12"
              required
              autoComplete="off"
              inputMode="decimal"
              aria-describedby="hts-hint"
              className={`tabular ${inputClass}`}
            />
          </Field>
          <Field
            id="country"
            label="Country of origin"
            hint="Where the goods were made, not where they ship from."
          >
            <input
              id="country"
              name="country"
              defaultValue={country}
              placeholder="e.g. Vietnam"
              required
              list="origins"
              autoComplete="off"
              aria-describedby="country-hint"
              className={inputClass}
            />
            <datalist id="origins">
              {ORIGINS.map((o) => (
                <option key={o} value={o} />
              ))}
            </datalist>
          </Field>
          <Field
            id="value"
            label="Entered value (USD)"
            hint="Goods value in dollars, e.g. 2499.50."
          >
            <input
              id="value"
              name="value"
              type="number"
              step="0.01"
              min="0.01"
              inputMode="decimal"
              defaultValue={rawValue}
              required
              aria-describedby="value-hint"
              className={`tabular ${inputClass}`}
            />
          </Field>
          <Field
            id="program"
            label="Preference program (optional)"
            hint="Only if you are claiming a special rate; we do not check your eligibility."
          >
            <input
              id="program"
              name="program"
              defaultValue={program}
              placeholder="e.g. KR"
              maxLength={8}
              autoCapitalize="characters"
              autoComplete="off"
              aria-describedby="program-hint"
              className={inputClass}
            />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id="quantity"
            label="Quantity (only for per-unit duties)"
            hint="Some goods are charged per kilogram or per piece. Enter how many, and the unit if it is not the one the duty uses."
          >
            <div className="grid grid-cols-[minmax(0,1fr)_6.5rem] gap-2">
              <input
                id="quantity"
                name="quantity"
                defaultValue={rawQuantity}
                placeholder="e.g. 2500"
                inputMode="decimal"
                autoComplete="off"
                aria-describedby="quantity-hint"
                className={`tabular ${inputClass}`}
              />
              <input
                id="unit"
                name="unit"
                aria-label="Quantity unit"
                defaultValue={quantityUnit}
                placeholder="kg"
                list="units"
                autoComplete="off"
                className={inputClass}
              />
              <datalist id="units">
                {["kg", "g", "lb", "t", "liter", "gal", "each", "doz", "pair"].map((u) => (
                  <option key={u} value={u} />
                ))}
              </datalist>
            </div>
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <RadioGroup
            legend="Transport"
            name="transport"
            value={transport}
            hint="Sea shipments pay the Harbor Maintenance Fee; air shipments do not."
            options={[
              { value: "sea", label: "Sea (vessel)" },
              { value: "air", label: "Air" },
            ]}
          />
          <RadioGroup
            legend="Entry type"
            name="entry"
            value={entry}
            hint="The Merchandise Processing Fee is added for formal entries only."
            options={[
              { value: "formal", label: "Formal entry" },
              { value: "informal", label: "Informal entry" },
            ]}
          />
        </div>

        <button
          type="submit"
          className="btn btn-primary"
        >
          Calculate
        </button>
      </form>

      {/* A second GET form. It carries the scenario as hidden fields so
          searching for a code does not throw the visitor's inputs away. */}
      <form action="/calculator" className="max-w-2xl" role="search">
        {Object.entries(scenario).map(([k, v]) =>
          v ? <input key={k} type="hidden" name={k} value={v} /> : null,
        )}
        <label htmlFor="q" className="block text-[13px] font-medium">
          Don&rsquo;t know the code? Search descriptions
        </label>
        <div className="mt-1 flex gap-2">
          <input
            id="q"
            name="q"
            defaultValue={q}
            placeholder="e.g. cotton t-shirt"
            autoComplete="off"
            className={`min-w-0 flex-1 ${inputClass}`}
          />
          <button
            type="submit"
            className="rounded-md border px-3 py-2 text-[14px] border-border"
          >
            Search
          </button>
        </div>
      </form>

      {searchProblem ? <Note role="alert">{searchProblem}</Note> : null}
      {matches && !matches.ok ? (
        <FailureNotice
          failure={matches}
          retryHref={href({ q })}
          subject="code search"
        />
      ) : null}
      {matches?.ok && matches.data.results.length === 0 ? (
        <p role="status" className="text-[14px] text-muted">
          No codes matched &ldquo;{q}&rdquo;. Try the material or what the
          goods do.
        </p>
      ) : null}
      {matches?.ok && matches.data.results.length > 0 ? (
        <Card>
          <div
            id="matches-label"
            className="text-[12px] uppercase tracking-wide text-muted"
          >
            Matching codes for &ldquo;{q}&rdquo;
          </div>
          <ul aria-labelledby="matches-label" className="mt-2 space-y-1.5 text-[14px]">
            {matches.data.results.slice(0, 8).map((r) => (
              <li key={r.hts}>
                <Link
                  href={href({ hts: r.hts, q: "" })}
                  className="tabular font-medium hover:underline text-accent"
                >
                  {r.hts}
                </Link>{" "}
                <span className="text-muted">{r.description}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {inputProblem ? <Note role="alert">{inputProblem}</Note> : null}
      {quote && !quote.ok ? (
        <FailureNotice
          failure={quote}
          retryHref={href()}
          subject="the duty estimate"
        />
      ) : null}

      {quote?.ok ? (
        <Estimate
          result={quote.data}
          country={country}
          bySea={transport === "sea"}
          formal={entry === "formal"}
          program={program || undefined}
          quantity={quantity !== null ? `${rawQuantity}${quantityUnit ? ` ${quantityUnit}` : ""}` : undefined}
        />
      ) : null}
    </div>
  );
}

function Estimate({
  result,
  country,
  bySea,
  formal,
  program,
  quantity,
}: {
  result: Quote;
  country: string;
  bySea: boolean;
  formal: boolean;
  program?: string;
  quantity?: string;
}) {
  const complete = isComplete(result);
  const flag = complete ? undefined : "Estimate is incomplete";
  const tone = complete ? undefined : "warn";
  return (
    <section aria-label="Estimate" className="space-y-6">
      <ScenarioLine
        quote={result}
        byVessel={bySea}
        formalEntry={formal}
        program={program}
        quantity={quantity}
      />
      <Assumptions quote={result} />

      <div className="grid gap-5 sm:grid-cols-3">
        <Card>
          <Stat
            label="Total duty and fees"
            value={money2(result.total_duty)}
            flag={flag}
            tone={tone}
          >
            <IncompleteReasons quote={result} />
          </Stat>
        </Card>
        <Card>
          <Stat
            label="Effective rate"
            value={`${result.effective_rate_pct}%`}
            sub="total duty and fees as a share of entered value"
            flag={flag}
            tone={tone}
          />
        </Card>
        <Card>
          <Stat
            label="Landed cost (value + duty and fees)"
            value={money2(result.landed_cost)}
            sub={`${money2(result.entered_value)} entered value plus duty and fees; freight, insurance and brokerage are not included`}
            flag={flag}
            tone={tone}
          />
        </Card>
      </div>

      <div className="scroll-x">
        <table className="w-full min-w-[520px] text-[14px]">
          <caption className="sr-only">
            Duty and fee components for HTS {result.hts} from{" "}
            {result.country}
          </caption>
          <thead>
            <tr className="border-b text-left border-border text-muted">
              <th scope="col" className="py-2 font-medium">
                Component
              </th>
              <th scope="col" className="py-2 text-right font-medium">
                Rate
              </th>
              <th scope="col" className="py-2 text-right font-medium">
                Amount
              </th>
              <th scope="col" className="py-2 pl-4 font-medium">
                Authority
              </th>
            </tr>
          </thead>
          <tbody>
            {result.components.map((c) => (
              <tr key={c.label} className="border-b border-border">
                <td className="py-2">{c.label}</td>
                <td className="tabular py-2 text-right">
                  {c.rate_pct !== null ? `${c.rate_pct}%` : "—"}
                </td>
                <td className="tabular py-2 text-right">
                  {money2(c.amount)}
                </td>
                <td className="py-2 pl-4 text-[13px] text-muted">
                  {c.authority}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-[14px]">
        Full detail for this code:{" "}
        <Link
          href={`/hts/${result.hts}?country=${encodeURIComponent(country)}`}
          className="tabular font-medium hover:underline text-accent"
        >
          {result.hts}
        </Link>
      </p>

      <RefundScenario
        amount={result.refundable_amount}
        entered={result.entered_value}
      />
      {result.warnings.map((w) => (
        <Note key={w}>{w}</Note>
      ))}
    </section>
  );
}
