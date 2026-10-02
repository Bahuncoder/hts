import Link from "next/link";

/** The three-step tool-card grid shown on marketing landing pages. Shared by
 *  the homepage and the China-tariffs landing page, which otherwise
 *  duplicated this markup verbatim except for the section heading and the
 *  tools listed. */
export default function ToolsGrid({
  heading, tools,
}: {
  heading: string;
  tools: { step: string; title: string; description: string; href: string; action: string }[];
}) {
  return (
    <section aria-labelledby="workflow-title">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">From question to decision</p>
          <h2 id="workflow-title" className="serif mt-2 text-3xl tracking-tight">{heading}</h2>
        </div>
        <Link href="/changes" className="text-sm font-medium text-accent hover:underline">
          Explore tariff changes <span aria-hidden="true">↗</span>
        </Link>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        {tools.map((tool) => (
          <Link key={tool.href} href={tool.href} className="tool-card">
            <span className="mono text-xs text-faint">{tool.step} /</span>
            <h3 className="serif text-2xl leading-tight tracking-tight">{tool.title}</h3>
            <p className="text-sm leading-relaxed text-muted">{tool.description}</p>
            <span className="tool-arrow">{tool.action} <span aria-hidden="true">→</span></span>
          </Link>
        ))}
      </div>
    </section>
  );
}
