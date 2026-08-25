import { getChanges } from "@/lib/api";
import { Badge, Card } from "@/components/ui";

export const metadata = {
  title: "US tariff changes — Federal Register tracker",
  description:
    "Every Section 232, Section 301, antidumping and tariff-rate quota action published in the Federal Register, with the HTS codes each one names.",
};

export const revalidate = 900;

export default async function ChangesPage() {
  const data = await getChanges(90);

  return (
    <div className="space-y-8">
      <div className="max-w-2xl space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Tariff changes</h1>
        <p style={{ color: "var(--muted)" }}>
          Rates move several times a week. These are the tariff actions published
          in the Federal Register in the last 90 days, with the HTS codes each
          names — so you can tell in seconds whether one touches your catalogue.
          Documents that merely mention a tariff term are filtered out.
        </p>
      </div>

      {!data || data.count === 0 ? (
        <Card>
          <p style={{ color: "var(--muted)" }}>
            No actions recorded yet. Run the Federal Register poller to populate
            this feed.
          </p>
        </Card>
      ) : (
        <div className="space-y-3">
          {data.changes.map((c) => (
            <Card key={c.document_number}>
              <div className="flex flex-wrap items-baseline gap-3">
                <span className="tabular text-[13px]" style={{ color: "var(--muted)" }}>
                  {c.publication_date}
                </span>
                <Badge>{c.doc_type}</Badge>
              </div>
              <a href={c.html_url} target="_blank" rel="noopener noreferrer"
                 className="mt-1 block font-medium hover:underline">
                {c.title}
              </a>
              {c.abstract ? (
                <p className="mt-2 text-[14px]" style={{ color: "var(--muted)" }}>
                  {c.abstract.slice(0, 280)}
                </p>
              ) : null}
              {c.hts_mentions.length === 0 ? (
                <p className="mt-2 text-[12px]" style={{ color: "var(--muted)" }}>
                  Names no specific HTS codes — most actions describe scope in prose.
                </p>
              ) : null}
              {c.hts_mentions.length ? (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {c.hts_mentions.slice(0, 14).map((h) => (
                    <a key={h} href={`/hts/${h}`}
                       className="tabular rounded border px-1.5 py-0.5 text-[12px] hover:underline"
                       style={{ borderColor: "var(--border)", color: "var(--accent)" }}>
                      {h}
                    </a>
                  ))}
                  {c.hts_mentions.length > 14 ? (
                    <span className="text-[12px]" style={{ color: "var(--muted)" }}>
                      +{c.hts_mentions.length - 14} more
                    </span>
                  ) : null}
                </div>
              ) : null}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
