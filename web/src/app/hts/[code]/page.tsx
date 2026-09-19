import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { getHts, money2 } from "@/lib/api";
import { ORIGINS, QUICK_ORIGINS } from "@/lib/origins";
import { Badge, Card, Note, Stat } from "@/components/ui";
import { Field, inputClass } from "@/components/Field";
import { FailureNotice } from "@/components/FailureNotice";
import {
  IncompleteReasons,
  RefundScenario,
  ScenarioLine,
  isComplete,
} from "@/components/QuoteFigures";
import { currentViewer } from "@/lib/auth";
import { isWatched } from "@/lib/catalogues";
import { watchCodeAction } from "@/lib/actions";
import { emailEnabled } from "@/lib/email";

export const revalidate = 3600;

/** The code pages price a fixed illustrative entry. */
const SCENARIO_VALUE = 10000;

type Props = {
  params: Promise<{ code: string }>;
  searchParams: Promise<{ country?: string | string[] }>;
};

const originOf = (v: string | string[] | undefined) =>
  ((Array.isArray(v) ? v[0] : v) ?? "").trim() || "China";

export async function generateMetadata({
  params,
  searchParams,
}: Props): Promise<Metadata> {
  const { code } = await params;
  const country = originOf((await searchParams).country);
  const r = await getHts(code, country, SCENARIO_VALUE);
  // An outage must not fail the page or stamp a wrong title on it; a failed
  // lookup is not something to index either.
  if (!r.ok) return { title: `HTS ${code}`, robots: { index: false } };
  const d = r.data;
  const q = d.quote;
  const rate = q
    ? `${q.effective_rate_pct}%${isComplete(q) ? "" : " (incomplete estimate)"}`
    : d.rates.general;
  return {
    title: `HTS ${d.hts} — ${d.description.slice(0, 60)} | duty rate from ${country}`,
    description:
      `Import duty for HTS ${d.hts}: ${d.description.slice(0, 90)}. ` +
      `Estimated rate from ${country} is ${rate}, including trade remedies, MPF and HMF, for a $10,000 entry.`,
    alternates: { canonical: `/hts/${d.hts}` },
  };
}

/** Quick origins as links, plus a free-text field for any other. */
function OriginPicker({ code, country }: { code: string; country: string }) {
  const base = `/hts/${encodeURIComponent(code)}`;
  return (
    <div className="space-y-3">
      <nav aria-label="Origin" className="flex flex-wrap gap-2 text-[13px]">
        <span className="text-muted">Origin:</span>
        {QUICK_ORIGINS.map((c) => {
          const active = c.toLowerCase() === country.toLowerCase();
          return (
            <a
              key={c}
              href={`${base}?country=${encodeURIComponent(c)}`}
              aria-current={active ? "true" : undefined}
              className={`rounded border px-2 py-0.5 hover:underline ${
                active
                  ? "font-medium border-accent text-accent"
                  : "border-border text-muted"
              }`}
            >
              {c}
            </a>
          );
        })}
      </nav>
      <form action={base} className="max-w-md">
        <Field
          id="origin"
          label="Another country of origin"
          hint="Where the goods were made, not where they ship from."
        >
          <div className="flex gap-2">
            <input
              id="origin"
              name="country"
              list="origins"
              autoComplete="off"
              placeholder="e.g. Thailand"
              aria-describedby="origin-hint"
              className={`min-w-0 flex-1 ${inputClass}`}
            />
            <datalist id="origins">
              {ORIGINS.map((o) => (
                <option key={o} value={o} />
              ))}
            </datalist>
            <button
              type="submit"
              className="rounded-md border px-3 py-2 text-[14px] border-border"
            >
              Show
            </button>
          </div>
        </Field>
      </form>
    </div>
  );
}

function scopeCountries(raw: string): string {
  try {
    const list = JSON.parse(raw || "[]");
    return Array.isArray(list) && list.length ? list.join(", ") : "all origins";
  } catch {
    return "all origins";
  }
}

export default async function HtsPage({ params, searchParams }: Props) {
  const { code } = await params;
  const country = originOf((await searchParams).country);
  const res = await getHts(code, country, SCENARIO_VALUE);

  // Only a real 404 from the engine is "no such code". An outage, a rate
  // limit or a rejected origin is not, and must not read as one.
  if (!res.ok && res.kind === "not_found") notFound();

  if (!res.ok) {
    const retry = `/hts/${encodeURIComponent(code)}?country=${encodeURIComponent(country)}`;
    return (
      <div className="space-y-8">
        <h1 className="tabular text-3xl font-semibold tracking-tight">
          {code}
        </h1>
        <FailureNotice
          failure={res}
          retryHref={retry}
          subject="this code page"
        />
        {res.kind === "invalid" ? (
          <div className="space-y-3">
            <p className="text-[14px] text-muted">
              Choose a different origin, or{" "}
              <a
                href={`/hts/${encodeURIComponent(code)}`}
                className="hover:underline text-accent"
              >
                start again with the default
              </a>
              .
            </p>
            <OriginPicker code={code} country={country} />
          </div>
        ) : null}
      </div>
    );
  }

  const d = res.data;
  const q = d.quote;
  const complete = q ? isComplete(q) : true;
  const flag = complete ? undefined : "Estimate is incomplete";
  const tone = complete ? undefined : "warn";
  const viewer = await currentViewer();
  const watched = viewer ? await isWatched(viewer.account.id, d.hts) : false;

  // What watching actually delivers depends on the plan and on whether email
  // is switched on; say only what is true for this visitor.
  const emailsToYou =
    Boolean(viewer?.plan.monitoring) &&
    viewer?.account.alert_emails !== 0 &&
    emailEnabled();
  const watchCopy = watched
    ? emailsToYou
      ? "You are emailed when a tariff action names this code, and it also appears in Alerts."
      : `A tariff action naming this code will appear in Alerts in the app.${viewer?.plan.monitoring ? "" : " Email alerts are part of Starter and above."}`
    : viewer?.plan.monitoring
      ? "Rates move several times a week. Watch this code to be alerted when a tariff action names it."
      : "Rates move several times a week. Watching a code shows tariff actions that name it in Alerts in the app; email alerts are part of Starter and above.";

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="tabular text-3xl font-semibold tracking-tight">
            {d.hts}
          </h1>
          {d.is_leaf ? (
            <Badge tone="good">statistical line</Badge>
          ) : (
            <Badge>heading</Badge>
          )}
        </div>
        <p className="text-lg">{d.description}</p>
        <p className="text-[13px] text-muted">{d.full_path}</p>
      </div>

      <OriginPicker code={d.hts} country={country} />

      {q ? (
        <>
          <div className="space-y-1">
            <ScenarioLine quote={q} />
            <p className="text-[13px] text-muted">
              Different value, transport or entry type?{" "}
              <Link
                href={`/calculator?hts=${encodeURIComponent(d.hts)}&country=${encodeURIComponent(country)}&value=${SCENARIO_VALUE}`}
                className="font-medium hover:underline text-accent"
              >
                Calculate this code
              </Link>
              .
            </p>
          </div>

          <div className="grid gap-5 sm:grid-cols-3">
            <Card>
              <Stat
                label={`Effective rate from ${country}`}
                value={`${q.effective_rate_pct}%`}
                flag={flag}
                tone={tone}
              />
            </Card>
            <Card>
              <Stat
                label="Duty on $10,000"
                value={money2(q.total_duty)}
                sub="including MPF and HMF"
                flag={flag}
                tone={tone}
              >
                <IncompleteReasons quote={q} />
              </Stat>
            </Card>
            <Card>
              <Stat
                label="IEEPA scenario estimate"
                value={money2(q.refundable_amount)}
                sub={
                  q.refundable_amount > 0
                    ? "if paid on an entry like this; not a claim amount"
                    : "none identified for this scenario"
                }
                tone={q.refundable_amount > 0 ? "recover" : undefined}
              />
            </Card>
          </div>

          <section className="space-y-3">
            <h2 className="text-xl font-semibold tracking-tight">Duty stack</h2>
            <div className="scroll-x">
              <table className="w-full min-w-[520px] text-[14px]">
                <caption className="sr-only">
                  Duty and fee components for HTS {d.hts} from {country} on a
                  $10,000 entry
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
                      On $10,000
                    </th>
                    <th scope="col" className="py-2 pl-4 font-medium">
                      Authority
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {q.components.map((c) => (
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
                  <tr className="font-semibold">
                    <td className="py-2">
                      Total{complete ? "" : " (incomplete)"}
                    </td>
                    <td className="tabular py-2 text-right">
                      {q.effective_rate_pct}%
                    </td>
                    <td className="tabular py-2 text-right">
                      {money2(q.total_duty)}
                    </td>
                    <td />
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <RefundScenario
            amount={q.refundable_amount}
            entered={q.entered_value}
          />

          {q.warnings.map((w) => (
            <Note key={w}>{w}</Note>
          ))}
        </>
      ) : (
        <Note>
          This is a heading rather than a 10-digit statistical line, so no duty
          is computed. Choose a statistical line beneath it.
        </Note>
      )}

      {d.trade_remedies.length ? (
        <section className="space-y-3">
          <h2 className="text-xl font-semibold tracking-tight">
            Trade remedies covering this code
          </h2>
          <div className="space-y-2">
            {d.trade_remedies.map((r) => (
              <Card key={r.heading}>
                <div className="flex flex-wrap items-center gap-3 text-[14px]">
                  <span className="tabular font-medium">{r.heading}</span>
                  {r.suspended ? (
                    <Badge tone="bad">suspended</Badge>
                  ) : (
                    <Badge tone="warn">in force</Badge>
                  )}
                  <span className="text-muted">
                    {scopeCountries(r.countries)}
                  </span>
                  <span className="tabular ml-auto">{r.raw_rate}</span>
                </div>
                <p className="mt-1 text-[12px] text-muted">
                  Scope from Chapter 99 U.S. Note {r.note}
                  {r.effective_from ? ` · effective ${r.effective_from}` : ""}
                </p>
              </Card>
            ))}
          </div>
        </section>
      ) : null}

      <div className="flex flex-wrap items-center gap-4 border-t pt-5 border-border">
        {viewer ? (
          <form action={watchCodeAction}>
            <input type="hidden" name="hts" value={d.hts} />
            <input type="hidden" name="watched" value={watched ? "1" : "0"} />
            <button
              className="px-4 py-2 text-[14px] font-medium"
              style={
                watched
                  ? { border: "1px solid var(--rule)", color: "var(--muted)" }
                  : { background: "var(--accent)", color: "var(--on-accent)" }
              }
            >
              {watched ? "Stop watching this code" : "Watch this code"}
            </button>
          </form>
        ) : (
          <a
            href="/signup"
            className="px-4 py-2 text-[14px] font-medium bg-accent text-on-accent"
          >
            Watch this code
          </a>
        )}
        <p className="max-w-xl text-[13px] text-muted">{watchCopy}</p>
      </div>

      {d.rulings.length ? (
        <section className="space-y-3">
          <h2 className="text-xl font-semibold tracking-tight">
            CBP rulings on this code
          </h2>
          <div className="space-y-1.5">
            {d.rulings.map((r) => (
              <div key={r.ruling_number} className="clamp-1 text-[14px]">
                <a
                  href={r.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium hover:underline text-accent"
                >
                  {r.ruling_number}
                </a>{" "}
                <span className="tabular text-[12px] text-muted">
                  {r.ruling_date}
                </span>{" "}
                {r.revoked ? <Badge tone="bad">revoked</Badge> : null}{" "}
                <span className="text-muted">{r.subject}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
