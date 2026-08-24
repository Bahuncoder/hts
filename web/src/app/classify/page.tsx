import { classify } from "@/lib/api";
import { Badge, Card, HtsLink, Note } from "@/components/ui";

export const metadata = {
  title: "HTS classification — describe your product",
  description:
    "Find the HTS code for a product, ranked by CBP ruling precedent with the rulings cited.",
};

export const dynamic = "force-dynamic";

export default async function ClassifyPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const result = q ? await classify(q) : null;

  return (
    <div className="space-y-8">
      <div className="max-w-2xl space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Classify a product</h1>
        <p style={{ color: "var(--muted)" }}>
          Describe the goods as you would to a broker: what it is, what it is made
          of, and what it does. Material and function decide most classifications.
        </p>
      </div>

      <form action="/classify" className="flex max-w-2xl flex-wrap gap-2">
        <input
          name="q"
          defaultValue={q ?? ""}
          placeholder="men's knitted cotton t-shirt, 100% cotton, short sleeve"
          className="min-w-0 flex-1 rounded-md border px-3 py-2 text-[15px]"
          style={{ borderColor: "var(--border)", background: "var(--bg)", color: "var(--ink)" }}
        />
        <button
          className="rounded-md px-4 py-2 text-[15px] font-medium"
          style={{ background: "var(--accent)", color: "var(--bg)" }}
        >
          Classify
        </button>
      </form>

      {result?.notes?.map((n) => <Note key={n}>{n}</Note>)}

      {result && result.candidates.length === 0 ? (
        <p style={{ color: "var(--muted)" }}>
          No candidates matched. Add the material and the function of the goods.
        </p>
      ) : null}

      <div className="space-y-4">
        {result?.candidates.map((c, i) => (
          <Card key={c.hts}>
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-[13px]" style={{ color: "var(--muted)" }}>#{i + 1}</span>
              <HtsLink code={c.hts} />
              <Badge tone={c.confidence === "high" ? "good" : c.confidence === "medium" ? "warn" : "neutral"}>
                {c.confidence} confidence
              </Badge>
              {c.ruling_support > 0 ? (
                <span className="text-[13px]" style={{ color: "var(--muted)" }}>
                  {c.ruling_support} CBP ruling{c.ruling_support === 1 ? "" : "s"}
                </span>
              ) : null}
              {c.general_rate ? (
                <span className="tabular ml-auto text-[13px]" style={{ color: "var(--muted)" }}>
                  MFN {c.general_rate}
                </span>
              ) : null}
            </div>

            <p className="mt-3 font-medium">{c.description}</p>
            <p className="clamp-2 mt-1 text-[13px]" style={{ color: "var(--muted)" }}>{c.full_path}</p>

            {c.reasoning ? <p className="mt-3 text-[14px]">{c.reasoning}</p> : null}

            {c.rulings.length ? (
              <div className="mt-4 space-y-1">
                <div className="text-[12px] uppercase tracking-wide" style={{ color: "var(--muted)" }}>
                  Precedent
                </div>
                {c.rulings.map((r) => (
                  <div key={r.ruling} className="clamp-1 text-[13px]">
                    <a href={r.url} target="_blank" rel="noopener noreferrer"
                       className="font-medium hover:underline" style={{ color: "var(--accent)" }}>
                      {r.ruling}
                    </a>{" "}
                    {r.revoked ? <Badge tone="bad">revoked</Badge> : null}{" "}
                    <span style={{ color: "var(--muted)" }}>{r.subject}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </Card>
        ))}
      </div>
    </div>
  );
}
