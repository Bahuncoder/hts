"use client";

import { Fragment } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { nextQuery, safeNext } from "@/lib/next";

export type NavItem = { href: string; label: string };
/** A group of destinations, in the order a person works: the thing they
 *  return to first, then the tools, then what watches for changes. */
export type NavGroup = { title: string; items: NavItem[] };

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
export function SiteNav({ groups }: { groups: NavGroup[] }) {
  const pathname = usePathname();
  return (
    <>
      <nav
        aria-label="Main"
        className="hidden items-center gap-1 xl:flex"
      >
        {groups.map((g, gi) => (
          <Fragment key={g.title}>
            {gi > 0 ? <span aria-hidden="true" className="mx-2 h-5 w-px bg-border" /> : null}
            {g.items.map((n) => (
              <NavLink key={n.href} href={n.href}>
                {n.label}
              </NavLink>
            ))}
          </Fragment>
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
          {groups.map((g) => {
            if (!g.items.length) return null;
            return (
              <div key={g.title}>
                <p className="px-1 text-[13px] font-medium text-muted">{g.title}</p>
                <ul className="flex flex-col">
                  {g.items.map((n) => (
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
