import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { classify, getHealth } from "@/lib/api";
import { allow, CLASSIFY_LIMIT } from "@/lib/budget";
import { clientId } from "@/lib/throttle";
import { Badge, Card, HtsLink, Note } from "@/components/ui";
import { FailureNotice } from "@/components/FailureNotice";
import { inputClass } from "@/components/Field";
import { CopyButton } from "@/components/CopyButton";

export const metadata = {
  title: "HTS classification — describe your product",
  description:
    "Find the HTS code for a product, ranked by CBP ruling precedent with the rulings cited.",
};

export const dynamic = "force-dynamic";

export default async function ClassifyPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const { q: rawQ } = await searchParams;
  const health = await getHealth();
  const edition = health.ok ? health.data.hts_edition : undefined;
  const q = (Array.isArray(rawQ) ? rawQ[0] : rawQ)?.trim() ?? "";
  // The engine needs three characters to classify; say so rather than spend a
  // budgeted call to be told it.
  const tooShort = q.length > 0 && q.length < 3;
  // Each search is engine work paid for with the shared key, so it is
  // budgeted per client like the audit proxy.
  const wait =
    q && !tooShort
      ? await allow("classify", `client:${await clientId()}`, CLASSIFY_LIMIT)
      : null;
  const outcome = q && !tooShort && wait === null ? await classify(q) : null;
  const result = outcome?.ok ? outcome.data : null;
  const retryHref = `/classify?q=${encodeURIComponent(q)}`;

  return (
    <div className="space-y-8">
      <PageHeader eyebrow="Product classification" title="Find the right HTS code" description="Start with what your product is, what it is made of, and how it is used. Compare candidate codes and the rulings behind them." />
      <div className="flex flex-wrap items-center justify-between gap-3 text-[13px] text-muted">
        <span>{edition ? `Reference data: ${edition}` : "Reference data edition unavailable"}</span>
        {q ? <Link href="/classify" className="font-medium text-accent hover:underline">Start over</Link> : null}
      </div>

      <form action="/classify" className="panel p-5 sm:p-7" role="search">
        <label htmlFor="q" className="block text-[13px] font-medium">
          Product description
        </label>
        <div className="mt-1 flex flex-wrap gap-2">
          <input
            id="q"
            data-search
            name="q"
            defaultValue={q}
            required
            minLength={3}
            autoComplete="off"
            aria-describedby="q-hint"
            placeholder="men's knitted cotton t-shirt, 100% cotton, short sleeve"
            className={`min-w-0 flex-1 ${inputClass}`}
          />
          <button
            type="submit"
            className="btn btn-primary"
          >
            Classify
          </button>
        </div>
        <p id="q-hint" className="mt-1 text-[12px] text-muted">
          At least 3 characters. Include what it is made of and what it does.
        </p>
      </form>

      {tooShort ? (
        <Note role="alert">
          Describe the product in at least 3 characters so there is something
          to match.
        </Note>
      ) : null}

      {wait !== null ? (
        <Note role="alert">
          Too many searches from this connection. Try again in {wait} seconds.
        </Note>
      ) : null}

      {outcome && !outcome.ok ? (
        <FailureNotice
          failure={outcome}
          retryHref={retryHref}
          subject="classification"
        />
      ) : null}

      {result && result.candidates.length > 0 ? (
        <p role="status" className="text-[13px] text-muted">
          {result.candidates.length} candidate
          {result.candidates.length === 1 ? "" : "s"} for &ldquo;{q}&rdquo;,
          ranked by ruling precedent. A candidate is a starting point for your
          broker, not a filing-ready code.
        </p>
      ) : null}

      {result?.notes?.map((n) => (
        <Note key={n}>{n}</Note>
      ))}

      {result && result.candidates.length === 0 ? (
        <p role="status" className="text-muted">
          No candidates matched. Add the material and the function of the goods.
        </p>
      ) : null}

      <div className="space-y-4">
        {result?.candidates.map((c, i) => (
          <Card key={c.hts}>
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-[13px] text-muted">#{i + 1}</span>
              <HtsLink code={c.hts} />
              <CopyButton value={c.hts} />
              {/* Never "good"/green: a candidate is never decided, at any
                  confidence level (see docs/STATUS.md's accuracy figures and
                  api/main.py's `low_confidence` gate, which the audit engine
                  applies regardless of bucket) -- this page must not look
                  more certain than that page does. */}
              <Badge tone={c.confidence === "low" ? "neutral" : "warn"}>
                {c.confidence} confidence
              </Badge>
              {c.ruling_support > 0 ? (
                <span className="text-[13px] text-muted">
                  {c.ruling_support} CBP ruling
                  {c.ruling_support === 1 ? "" : "s"}
                </span>
              ) : null}
              {c.general_rate ? (
                <span className="tabular ml-auto text-[13px] text-muted">
                  MFN {c.general_rate}
                </span>
              ) : null}
            </div>

            <p className="mt-3 font-medium">{c.description}</p>
            <details className="mt-2 text-[13px] text-muted"><summary className="cursor-pointer text-accent">View classification path</summary><p className="mt-2">{c.full_path}</p></details>

            {c.reasoning ? (
              <p className="mt-3 text-[14px]">{c.reasoning}</p>
            ) : null}

            {c.rulings.length ? (
              <div className="mt-4 space-y-1">
                <div className="text-[12px] uppercase tracking-wide text-muted">
                  Precedent
                </div>
                {c.rulings.map((r) => (
                  <div key={r.ruling} className="text-[13px]">
                    <a
                      href={r.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium hover:underline text-accent"
                    >
                      {r.ruling}
                    <span aria-hidden="true" className="ml-0.5">↗</span><span className="sr-only"> (opens in a new tab)</span></a>{" "}
                    {r.revoked ? <Badge tone="bad">revoked</Badge> : null}{" "}
                    <span className="text-muted">{r.subject}</span>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="mt-5 border-t border-border pt-4">
              <Link href={`/calculator?hts=${encodeURIComponent(c.hts)}`} className="btn btn-secondary">Estimate duty for this code <span aria-hidden="true">→</span></Link>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
