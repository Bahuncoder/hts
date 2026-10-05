import Link from "next/link";
import { Lockup } from "@/components/Logo";

const COLUMNS = [
  {
    title: "Product",
    links: [
      { href: "/classify", label: "Classify a product" },
      { href: "/calculator", label: "Duty calculator" },
      { href: "/audit", label: "Catalogue audit" },
    ],
  },
  {
    title: "Monitoring",
    links: [{ href: "/changes", label: "Tariff changes" }],
  },
  {
    title: "Company",
    links: [
      { href: "/pricing", label: "Plans and pricing" },
      { href: "/docs/api", label: "API documentation" },
      { href: "/terms", label: "Terms" },
      { href: "/privacy", label: "Privacy" },
    ],
  },
];

/** The site footer. Every visitor sees the same links, the legal line in full,
 *  and the appearance choice. Nothing important is hidden behind a disclosure. */
export default function SiteFooter() {
  return (
    <footer className="site-footer mt-16 border-t border-border bg-sunk">
      <div className="mx-auto max-w-7xl px-5 py-12 sm:px-8">
        <div className="grid gap-10 md:grid-cols-[1.4fr_repeat(3,1fr)]">
          <div className="space-y-4">
            <Link href="/" aria-label="HTSDesk home" className="inline-block">
              <Lockup mark={26} word={17} />
            </Link>
            <p className="max-w-xs text-[14px] leading-relaxed text-muted">
              Duty estimates you can check, with the evidence behind each figure.
            </p>
          </div>

          {COLUMNS.map((col) => (
            <nav key={col.title} aria-label={`Footer: ${col.title}`} className="space-y-3">
              <h2 className="text-[13px] font-semibold text-ink">{col.title}</h2>
              <ul className="space-y-2.5 text-[14px] text-muted">
                {col.links.map((l) => (
                  <li key={l.href}>
                    <Link href={l.href} className="hover:text-ink">
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <div className="mt-10 border-t border-border pt-6">
          <div className="max-w-3xl space-y-2 text-[13px] leading-relaxed text-muted">
            <p>
              Rates are derived from the USITC Harmonized Tariff Schedule, the Chapter 99 U.S. Notes and the
              Federal Register.
            </p>
            <p>
              HTSDesk is decision support, not customs advice. The importer of record&rsquo;s duty of reasonable
              care under 19 U.S.C. §1484 cannot be delegated. Confirm classifications with your broker before entry.
            </p>
            <p>
              Questions: <a href="mailto:hello@htsdesk.com" className="text-accent hover:underline">hello@htsdesk.com</a>
            </p>
          </div>

        </div>
      </div>
    </footer>
  );
}
