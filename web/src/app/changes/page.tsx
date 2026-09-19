import { getChanges } from "@/lib/api";
import { Badge, Card } from "@/components/ui";
import { Field, inputClass } from "@/components/Field";
import { FailureNotice } from "@/components/FailureNotice";

export const metadata = {
  title: "US tariff changes — Federal Register tracker",
  description:
    "Section 232, Section 301, antidumping and tariff-rate quota actions published in the Federal Register, with the HTS codes each one names.",
};

const DAYS = 90;
/** Codes shown before the rest fold into an expandable list. */
const SHOWN = 14;

const digits = (s: string) => s.replace(/\D/g, "");

export default async function ChangesPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string | string[] }>;
}) {
  const { code: rawCode } = await searchParams;
  const typed = ((Array.isArray(rawCode) ? rawCode[0] : rawCode) ?? "").trim();
  const prefix = digits(typed);

  const res = await getChanges(DAYS);

  const all = res.ok ? res.data.changes : [];
  // Filtering is by the digits of the code, so "6109", "6109.10" and
  // "6109.10.00" all narrow the same way and a typed dot never hides a match.
  const more = res.ok && res.data.has_more
    ? ` Only the ${all.length} most recent actions were searched.`
    : "";
  const shown = prefix
    ? all.filter((c) => c.hts_mentions.some((h) => digits(h).startsWith(prefix)))
    : all;

  return (
    <div className="space-y-8">
      <div className="max-w-2xl space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">
          Tariff changes
        </h1>
        <p className="text-muted">
          Rates move several times a week. These are the tariff actions
          published in the Federal Register in the last {DAYS} days, with the
          HTS codes each names — so you can tell in seconds whether one touches
          your catalogue. Documents that merely mention a tariff term are
          filtered out.
        </p>
      </div>

      <form action="/changes" className="max-w-md" role="search">
        <Field
          id="code"
          label="Only actions naming codes starting with"
          hint="For example 6109 or 6109.10. Leave empty to see everything."
        >
          <div className="flex gap-2">
            <input
              id="code"
              name="code"
              defaultValue={typed}
              placeholder="6109"
              inputMode="decimal"
              autoComplete="off"
              aria-describedby="code-hint"
              className={`tabular min-w-0 flex-1 ${inputClass}`}
            />
            <button
              type="submit"
              className="rounded-md border px-3 py-2 text-[14px] border-border"
            >
              Filter
            </button>
            {typed ? (
              <a
                href="/changes"
                className="rounded-md border px-3 py-2 text-[14px] border-border text-muted"
              >
                Clear
              </a>
            ) : null}
          </div>
        </Field>
      </form>

      {!res.ok ? (
        <FailureNotice
          failure={res}
          retryHref={typed ? `/changes?code=${encodeURIComponent(typed)}` : "/changes"}
          subject="the tariff changes feed"
        />
      ) : res.data.count === 0 ? (
        <Card>
          <p role="status" className="text-muted">
            No tariff actions are on file for the last {DAYS} days. If you
            expected some, check the Federal Register directly — this feed may
            be catching up.
          </p>
        </Card>
      ) : (
        <div className="space-y-3">
          <p role="status" className="text-[13px] text-muted">
            {prefix
              ? shown.length === 0
                ? `No actions in the last ${DAYS} days name a code starting with ${typed}.${more}`
                : `${shown.length} of ${all.length} actions name a code starting with ${typed}.${more}`
              : `${all.length} action${all.length === 1 ? "" : "s"}${
                  res.data.has_more
                    ? `, the most recent ${all.length} of the last ${DAYS} days`
                    : ""
                }.`}
          </p>
          {shown.map((c) => {
            // With a filter on, put the codes that matched first so the
            // reason this action is listed is the first thing seen.
            const unique = [...new Set(c.hts_mentions)];
            const mentions = prefix
              ? unique.sort(
                  (a, b) =>
                    Number(digits(b).startsWith(prefix)) -
                    Number(digits(a).startsWith(prefix)),
                )
              : unique;
            const head = mentions.slice(0, SHOWN);
            const rest = mentions.slice(SHOWN);
            return (
              <Card key={c.document_number}>
                <div className="flex flex-wrap items-baseline gap-3">
                  <span className="tabular text-[13px] text-muted">
                    {c.publication_date}
                  </span>
                  <Badge>{c.doc_type}</Badge>
                </div>
                <a
                  href={c.html_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1 block font-medium hover:underline"
                >
                  {c.title}
                </a>
                {c.abstract ? (
                  <p className="mt-2 text-[14px] text-muted">
                    {c.abstract.slice(0, 280)}
                  </p>
                ) : null}
                {mentions.length === 0 ? (
                  <p className="mt-2 text-[12px] text-muted">
                    Names no specific HTS codes — most actions describe scope
                    in prose.
                  </p>
                ) : (
                  <>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {head.map((h) => (
                        <a
                          key={h}
                          href={`/hts/${h}`}
                          className="tabular rounded border px-1.5 py-0.5 text-[12px] hover:underline border-border text-accent"
                        >
                          {h}
                        </a>
                      ))}
                    </div>
                    {rest.length ? (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-[12px] text-muted hover:underline">
                          +{rest.length} more code{rest.length === 1 ? "" : "s"}
                        </summary>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {rest.map((h) => (
                            <a
                              key={h}
                              href={`/hts/${h}`}
                              className="tabular rounded border px-1.5 py-0.5 text-[12px] hover:underline border-border text-accent"
                            >
                              {h}
                            </a>
                          ))}
                        </div>
                      </details>
                    ) : null}
                  </>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
