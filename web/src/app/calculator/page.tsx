import { PageHeader } from "@/components/PageHeader";
import Link from "next/link";
import { getHealth, getHts, getQuote, money2, search, type HtsDetail, type Quote } from "@/lib/api";
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
  const health = await getHealth();
  const edition = health.ok ? health.data.hts_edition : undefined;

  // Everything the visitor typed is kept verbatim so a failure never costs
  // them their entry.
  const hts = (one(sp.hts) ?? "").trim();
  const country = (one(sp.country) ?? "").trim();
  const rawValue = one(sp.value) ?? "";
  const transport = one(sp.transport) === "air" ? "air" : "sea";
  const entry = one(sp.entry) === "informal" ? "informal" : "formal";
  const program = (one(sp.program) ?? "").trim().toUpperCase().slice(0, 8);
  const rawQuantity = (one(sp.quantity) ?? "").trim();
  const quantityUnit = (one(sp.unit) ?? "").trim().slice(0, 32);
  const rawMetal = (one(sp.metal) ?? "").trim();
  const vehicleUse = ["passenger", "heavy", "none"].includes(one(sp.vehicle) ?? "") ? (one(sp.vehicle) as string) : "";
  const endUse = ["civil aircraft", "pharmaceutical"].includes(one(sp.enduse) ?? "") ? (one(sp.enduse) as string) : "";
  const q = (one(sp.q) ?? "").trim();
  const findOpen = one(sp.find) === "1" || Boolean(q);

  const scenario: Record<string, string> = {
    hts,
    country,
    value: rawValue,
    transport,
    entry,
    program,
    quantity: rawQuantity,
    unit: quantityUnit,
    metal: rawMetal,
    vehicle: vehicleUse,
    enduse: endUse,
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
  const metalWeight = rawMetal ? Number(rawMetal.replace(/[%\s]/g, "")) : null;
  const metalBad = metalWeight !== null && !(Number.isFinite(metalWeight) && metalWeight >= 0 && metalWeight <= 100);
  let inputProblem: string | null = null;
  if (hts) {
    if (!country) {
      inputProblem =
        "Enter a country of origin so the right duties are applied.";
    } else if (value === null) {
      inputProblem =
        "Enter an entered value above $0, for example 10000 or 2499.50.";
    } else if (metalBad) {
      inputProblem = "Enter the metal weight as a percentage from 0 to 100, or leave it blank.";
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
          metalWeightPct: metalWeight !== null && !metalBad ? metalWeight : undefined,
          vehicleUse: vehicleUse || undefined,
          endUse: endUse || undefined,
        })
      : null;

  // Before the duty is relied on, say what the tariff calls this code, so a
  // wrong digit is caught here rather than in the estimate.
  // The tariff is written with dots (6109.10.00.12); a bare 10-digit code is
  // formatted the same way before the lookup.
  const digits = hts.replace(/\D/g, "");
  const lookupCode = digits.length === 10
    ? `${digits.slice(0, 4)}.${digits.slice(4, 6)}.${digits.slice(6, 8)}.${digits.slice(8, 10)}`
    : hts;
  const codeCheck = hts && health.ok
    ? await getHts(lookupCode, country || "China", value ?? 10000)
    : null;

  // --- find a code -----------------------------------------------------
  const searchProblem =
    q && q.length < 2 ? "Type at least 2 characters to search." : null;
  const matches = q && !searchProblem ? await search(q) : null;

  return (
    <div className="space-y-8">
      <PageHeader eyebrow="Duty calculator" title="Know your duty exposure" description="Build an estimate for one customs entry. Choose the origin and shipping assumptions, then explore every duty and fee." />

      {/* A second GET form. It carries the scenario as hidden fields so
          searching for a code does not throw the visitor's inputs away. Shown
          first: most visitors arrive without an HTS code in hand. */}
      {/* Both choices submit the main form, so anything typed in it is kept.
          The hidden first button is the one Enter presses in the fields: it must
          stay the calculation, not "Find a code". */}
      <button type="submit" form="calc-form" hidden tabIndex={-1} aria-hidden="true" />
      <nav aria-label="How do you want to start?" className="flex flex-wrap gap-2">
        <button type="submit" form="calc-form" aria-current={findOpen ? undefined : "true"} className={`btn ${findOpen ? "btn-secondary" : "btn-selected"}`}>I know my code</button>
        <button type="submit" form="calc-form" name="find" value="1" aria-current={findOpen ? "true" : undefined} className={`btn ${findOpen ? "btn-selected" : "btn-secondary"}`}>Find a code</button>
      </nav>
      {findOpen ? (
        <div id="find-code" className="max-w-2xl">
          <form action="/calculator" className="panel space-y-3 p-5">
              {Object.entries(scenario).map(([k, v]) =>
                v ? <input key={k} type="hidden" name={k} value={v} /> : null,
              )}
              <div>
                <h2 className="text-[18px] font-semibold">Don&rsquo;t know your HTS code?</h2>
                <p className="mt-0.5 text-[13px] text-muted">Describe the product and we&rsquo;ll suggest candidates.</p>
              </div>
              <label htmlFor="q" className="sr-only">
                Search descriptions
              </label>
              <div className="flex gap-2">
                <input
                  id="q"
                  data-search
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
        </div>
      ) : null}

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
            className="text-[13px] font-medium text-muted"
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

      <div id="code-form">
        <h2 className="sr-only">I know my code</h2>
        <p className="mt-0.5 text-[13px] text-muted">Enter it below along with origin and value.</p>
      </div>

      <form id="calc-form" action="/calculator" className="panel space-y-6 p-5 sm:p-6">
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
        </div>
        <div className="space-y-3">
          {/* The estimate's own failure notice already says a code is not found, so
              these only show when that notice is not already there. */}
              {!(quote && !quote.ok) && codeCheck && !codeCheck.ok && codeCheck.kind === "not_found" ? (
            <Note role="alert">
              We do not recognise <span className="mono">{hts}</span> as a tariff code. Check the digits, or use Find a code.
            </Note>
          ) : null}
              {!(quote && !quote.ok) && codeCheck?.ok && !codeCheck.data.is_leaf ? (
            <Note role="alert">
              <span className="mono">{codeCheck.data.hts}</span> is a heading, not a full code. Choose the code that
              matches your product before you rely on the duty.
            </Note>
          ) : null}
              {codeCheck?.ok && codeCheck.data.is_leaf ? <CodeConfirmation detail={codeCheck.data} /> : null}
        </div>

        <details className="border-t border-border pt-4" open={Boolean(program || rawQuantity)}>
          <summary className="cursor-pointer text-[14px] font-medium">Quantity or preference program (only if they apply)</summary>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
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
        </details>

        <details className="border-t border-border pt-4" open={Boolean(rawMetal || vehicleUse || endUse)}>
          <summary className="cursor-pointer text-[14px] font-medium">About the goods (optional)</summary>
          <p className="mt-2 text-[13px] text-muted">
            Some duties depend on what the goods are used for or made of. Leave these blank if you do not
            know; the estimate will say when one of them would change the answer.
          </p>
          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            <Field id="metal" label="Metal weight (%)" hint="Share of the article's weight that is aluminum, steel or copper.">
              <input id="metal" name="metal" defaultValue={rawMetal} placeholder="e.g. 60" inputMode="decimal"
                autoComplete="off" aria-describedby="metal-hint" className={`tabular ${inputClass}`} />
            </Field>
            <Field id="vehicle" label="Vehicle parts" hint="Are the goods parts of a passenger vehicle, a medium- or heavy-duty vehicle, or neither?">
              <select id="vehicle" name="vehicle" defaultValue={vehicleUse} aria-describedby="vehicle-hint" className={inputClass}>
                <option value="">Not stated</option>
                <option value="passenger">Passenger vehicle or light truck</option>
                <option value="heavy">Medium- or heavy-duty vehicle</option>
                <option value="none">Not a vehicle part</option>
              </select>
            </Field>
            <Field id="enduse" label="End use claimed" hint="Only if you certify it: it removes the country-wide duty on listed codes.">
              <select id="enduse" name="enduse" defaultValue={endUse} aria-describedby="enduse-hint" className={inputClass}>
                <option value="">None</option>
                <option value="civil aircraft">Civil aircraft</option>
                <option value="pharmaceutical">Pharmaceutical</option>
              </select>
            </Field>
          </div>
        </details>

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

        <div className="flex flex-wrap items-center justify-between gap-3">
          <button type="submit" className="btn btn-primary">
            Calculate
          </button>
          <div className="flex flex-wrap items-center gap-4 text-[12px] text-faint">
            <span>{edition ? `Reference data: ${edition}` : health.ok ? null : "Reference data is temporarily unavailable"}</span>
            {hts || country || rawValue || q ? <Link href="/calculator" className="hover:text-ink hover:underline">Start over</Link> : null}
          </div>
        </div>
      </form>

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

      <div className="scroll-x" tabIndex={0} role="region" aria-label="Duty breakdown table">
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

/** What the tariff calls the code the visitor entered, so they can confirm it
 *  is the right one before the duty is shown. */
function CodeConfirmation({ detail }: { detail: HtsDetail }) {
  return (
    <section aria-label="Confirm this code" className="space-y-1 border-l-2 border-accent bg-accent-soft py-3 pl-4 pr-4">
      <p className="text-[13px] font-medium text-muted">The tariff calls this code</p>
      <p className="mono text-[15px] font-medium">{detail.hts}</p>
      <p className="text-[15px]">{detail.description}</p>
      {detail.full_path ? <p className="text-[13px] text-muted">{detail.full_path}</p> : null}
      {detail.rates.general ? <p className="text-[13px] text-muted">General rate: <span className="mono">{detail.rates.general}</span></p> : null}
    </section>
  );
}
