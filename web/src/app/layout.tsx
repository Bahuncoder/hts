import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.SITE_URL ?? "http://localhost:3000"),
  title: {
    default: "Tariffwise — US import duty, HTS codes and tariff changes",
    template: "%s | Tariffwise",
  },
  description:
    "Work out what a shipment actually costs to import into the US. Live HTS duty rates, Section 232 and 301 exposure, and classification backed by CBP rulings.",
};

const NAV = [
  { href: "/classify", label: "Classify" },
  { href: "/calculator", label: "Duty calculator" },
  { href: "/changes", label: "Tariff changes" },
  { href: "/audit", label: "Catalogue audit" },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="border-b" style={{ borderColor: "var(--border)" }}>
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
            <Link href="/" className="text-[15px] font-semibold tracking-tight">
              Tariffwise
            </Link>
            <nav className="flex flex-wrap gap-x-5 gap-y-1 text-[14px]">
              {NAV.map((n) => (
                <Link
                  key={n.href}
                  href={n.href}
                  className="hover:underline"
                  style={{ color: "var(--muted)" }}
                >
                  {n.label}
                </Link>
              ))}
            </nav>
          </div>
        </header>

        <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>

        <footer
          className="mt-16 border-t px-4 py-8 text-[13px]"
          style={{ borderColor: "var(--border)", color: "var(--muted)" }}
        >
          <div className="mx-auto max-w-6xl space-y-2">
            <p>
              Rates are derived from the USITC Harmonized Tariff Schedule, the
              Chapter 99 U.S. Notes and the Federal Register.
            </p>
            <p>
              Tariffwise is decision support, not customs advice. The importer of
              record&rsquo;s duty of reasonable care under 19 U.S.C. §1484 cannot be
              delegated — confirm classifications with your broker before entry.
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
