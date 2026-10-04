"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { nextQuery, safeNext } from "@/lib/next";

type Item = { href: string; label: string };

/** How the mobile menu groups the destinations. Account actions live in the
 *  header, next to the account link. */
const MENU_GROUPS: { title: string; hrefs: string[] }[] = [
  { title: "Analyze", hrefs: ["/classify", "/calculator", "/audit"] },
  { title: "Monitor", hrefs: ["/changes", "/alerts"] },
  { title: "Work", hrefs: ["/catalogues"] },
];

function isActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** A header link that says where you are. The current page is marked with
 *  aria-current and with weight and a visible marker, so it never depends on colour
 *  alone. */
export function NavLink({
  href,
  children,
  className = "",
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
}) {
  const active = isActive(usePathname(), href);
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`nav-item ${className}`}
    >
      {children}
    </Link>
  );
}

/** Primary navigation. At wide desktop sizes it is an inline row. Below that it folds
 *  into a <details> menu, which is keyboard-operable with no script. The menu
 *  is keyed by pathname so it closes itself when a link is followed. */
export function SiteNav({ items }: { items: Item[] }) {
  const pathname = usePathname();
  return (
    <>
      <nav
        aria-label="Main"
        className="hidden gap-1 xl:flex"
      >
        {items.map((n) => (
          <NavLink key={n.href} href={n.href}>
            {n.label}
          </NavLink>
        ))}
      </nav>

      <details
        key={pathname}
        className="order-last basis-full text-[14px] xl:hidden"
      >
        <summary className="cursor-pointer list-none rounded border px-3 py-1.5 font-medium border-border [&::-webkit-details-marker]:hidden">
          Menu <span aria-hidden="true" className="float-right">＋</span>
        </summary>
        <nav aria-label="Main" className="mt-2 space-y-4">
          {MENU_GROUPS.map((g) => {
            const groupItems = items.filter((n) => g.hrefs.includes(n.href));
            if (!groupItems.length) return null;
            return (
              <div key={g.title}>
                <p className="px-1 text-[13px] font-medium text-muted">{g.title}</p>
                <ul className="flex flex-col">
                  {groupItems.map((n) => (
                    <li key={n.href}>
                      <NavLink href={n.href} className="block py-2">
                        {n.label}
                      </NavLink>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </nav>
      </details>
    </>
  );
}

/** Sign in / Start free. Where the visitor is now travels with them when it is
 *  a place they can be sent back to (lib/next.ts allowlist), so signing in
 *  from the audit lands on the audit. */
export function SignedOutLinks() {
  const q = nextQuery(safeNext(usePathname()));
  return (
    <>
      <NavLink href={`/login${q}`}>Sign in</NavLink>
      <Link href={`/signup${q}`} className="btn btn-primary">
        Start free
      </Link>
    </>
  );
}
