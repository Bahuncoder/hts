import type { Metadata } from "next";
import Link from "next/link";
import { Lockup } from "@/components/Logo";
import { NavLink, SiteNav } from "@/components/SiteNav";
import { currentViewer } from "@/lib/auth";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.SITE_URL ?? "http://localhost:3000"),
  title: {
    default: "HTSDesk — US import duty, HTS codes and tariff changes",
    template: "%s | HTSDesk",
  },
  description:
    "Describe your product in plain words and get its HTS classification, the CBP rulings behind it, and the full duty stack — Section 232, Section 301, MPF and HMF — with the authority for every line.",
};

const NAV = [
  { href: "/classify", label: "Classify" },
  { href: "/calculator", label: "Duty calculator" },
  { href: "/changes", label: "Tariff changes" },
  { href: "/audit", label: "Catalogue audit" },
  { href: "/pricing", label: "Pricing" },
];

const SIGNED_IN_NAV = [
  { href: "/catalogues", label: "Catalogues" },
  { href: "/alerts", label: "Alerts" },
];

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const viewer = await currentViewer();
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin=""
        />
        {/* Root-layout <head> is the App Router place for site-wide font
            links; the rule below is written for the Pages Router and flags
            this as page-scoped, which it is not. */}
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;450;500;600&family=Newsreader:opsz,wght@6..72,400;6..72,500&display=swap"
        />
      </head>
      <body>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-2 focus:z-50 focus:px-3 focus:py-2 focus:text-[14px] focus:font-medium focus:bg-accent focus:text-on-accent"
        >
          Skip to main content
        </a>
        <header className="border-b border-border">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
            <Link href="/" aria-label="HTSDesk home">
              <Lockup />
            </Link>
            <SiteNav
              items={[...NAV, ...(viewer ? SIGNED_IN_NAV : [])]}
            />
            <div className="ml-auto flex items-center gap-4 text-[14px]">
              {viewer ? (
                <>
                  <span className="mono hidden text-[12px] sm:inline text-faint">
                    {viewer.plan.name}
                  </span>
                  <NavLink href="/account">Account</NavLink>
                </>
              ) : (
                <>
                  <NavLink href="/login">Sign in</NavLink>
                  <Link
                    href="/signup"
                    className="px-3 py-1.5 font-medium bg-accent text-on-accent"
                  >
                    Start free
                  </Link>
                </>
              )}
            </div>
          </div>
        </header>

        <main id="main" tabIndex={-1} className="mx-auto max-w-6xl px-4 py-8">
          {children}
        </main>

        <footer className="mt-16 px-4 py-8 text-[13px] border-t border-border text-faint">
          <div className="mx-auto max-w-6xl space-y-2">
            <p>
              Rates are derived from the USITC Harmonized Tariff Schedule, the
              Chapter 99 U.S. Notes and the Federal Register.
            </p>
            <p>
              HTSDesk is decision support, not customs advice. The importer of
              record&rsquo;s duty of reasonable care under 19 U.S.C. §1484
              cannot be delegated — confirm classifications with your broker
              before entry.
            </p>
            <p className="flex flex-wrap gap-x-4 gap-y-1 pt-1">
              <Link href="/terms" className="hover:underline">
                Terms
              </Link>
              <Link href="/privacy" className="hover:underline">
                Privacy
              </Link>
              <a href="mailto:hello@htsdesk.com" className="hover:underline">
                hello@htsdesk.com
              </a>
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
