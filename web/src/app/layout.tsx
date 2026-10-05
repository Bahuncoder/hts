import type { Metadata } from "next";
import Link from "next/link";
import { IBM_Plex_Mono, IBM_Plex_Sans, Newsreader } from "next/font/google";
import { Lockup } from "@/components/Logo";
import SiteFooter from "@/components/SiteFooter";
import { KeyShortcuts } from "@/components/KeyShortcuts";
import { AccountMenu, SignedOutLinks, SiteNav, type NavGroup } from "@/components/SiteNav";
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

// Fonts are downloaded at BUILD time and served from our own origin, so a page
// view makes no request to Google and does not hand it the visitor's address.
// Only the weights the design uses are shipped (400/500/600 for text and
// figures; Newsreader is the one variable file, so headings keep their
// optical-size cut). The variables feed the --sans/--mono/--serif tokens in
// globals.css, which carry the fallbacks.
const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
  variable: "--font-plex-sans",
});
const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
  variable: "--font-plex-mono",
});
const newsreader = Newsreader({
  subsets: ["latin"],
  axes: ["opsz"],
  display: "swap",
  variable: "--font-newsreader",
});

/** Navigation follows the work. Signed in, Catalogues and Review come first,
 *  since that is where waiting work is. Review opens the catalogue with a line
 *  still awaiting a decision (app/review/page.tsx). */
function navGroups(signedIn: boolean): NavGroup[] {
  return [
    ...(signedIn
      ? [{ title: "Work", items: [{ href: "/catalogues", label: "Catalogues" }, { href: "/review", label: "Review" }] }]
      : []),
    {
      title: "Analyze",
      items: [
        { href: "/classify", label: "Classify" },
        { href: "/calculator", label: "Duty calculator" },
        { href: "/audit", label: "Catalogue audit" },
      ],
    },
    {
      title: "Monitor",
      items: [
        { href: "/changes", label: "Tariff changes" },
        ...(signedIn ? [{ href: "/alerts", label: "Alerts" }] : []),
      ],
    },
  ];
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const viewer = await currentViewer();
  return (
    <html
      lang="en"
      className={`${plexSans.variable} ${plexMono.variable} ${newsreader.variable}`}
    >
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: 'try{var t=localStorage.getItem("htsdesk.theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t;}catch(e){}',
          }}
        />
      </head>
      <body>
        <KeyShortcuts />
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-2 focus:z-50 focus:px-3 focus:py-2 focus:text-[14px] focus:font-medium focus:bg-accent focus:text-on-accent"
        >
          Skip to main content
        </a>
        <header className="site-header">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-9 gap-y-3 px-5 py-3 sm:px-8 min-h-[68px]">
            <Link href="/" aria-label="HTSDesk home">
              <Lockup mark={32} word={20} />
            </Link>
            <SiteNav groups={navGroups(Boolean(viewer))} />
            <div className="ml-auto flex items-center gap-4 text-[14px]">
              {viewer ? (
                <>
                  <AccountMenu />
                </>
              ) : (
                <SignedOutLinks />
              )}
            </div>
          </div>
        </header>

        <main id="main" tabIndex={-1} className="workspace-main mx-auto max-w-7xl px-5 py-8 sm:px-8 sm:py-10">
          {children}
        </main>

        <SiteFooter />
      </body>
    </html>
  );
}
