"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { nextQuery, safeNext } from "@/lib/next";
import { ThemeSelect } from "@/components/ThemeSelect";

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

/** Native disclosures retain keyboard support; dismiss on outside click or focus exit. */
function HeaderDropdown({ label, active = false, children }: {
  label: string; active?: boolean; children: React.ReactNode;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const pathname = usePathname();
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) ref.current.open = false;
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  return (
    <details key={pathname} ref={ref} className="header-dropdown"
      onKeyDown={(event) => {
        if (event.key === "Escape" && event.currentTarget.open) {
          event.currentTarget.open = false;
          event.currentTarget.querySelector<HTMLElement>("summary")?.focus();
        }
      }}
      onBlur={(event) => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) event.currentTarget.open = false;
      }}>
      <summary className={`nav-item header-trigger ${active ? "header-trigger-active" : ""}`}>
        {label}<svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </summary>
      <div className="header-dropdown-panel">{children}</div>
    </details>
  );
}

export function AccountMenu() {
  const pathname = usePathname();
  return (
    <HeaderDropdown label="Account" active={isActive(pathname, "/account")}>
      <NavLink href="/account" className="header-menu-link">Account settings</NavLink>
      <NavLink href="/pricing" className="header-menu-link">Plans and billing</NavLink>
      <div className="header-appearance"><ThemeSelect id="account-theme" /></div>
    </HeaderDropdown>
  );
}

export function SiteNav({ groups }: { groups: NavGroup[] }) {
  const pathname = usePathname();
  return (
    <>
      <nav aria-label="Main" className="hidden items-center gap-2 lg:flex">
        {groups.map((group) => group.title === "Work" ? group.items.map((item) => (
          <NavLink key={item.href} href={item.href}>{item.label}</NavLink>
        )) : (
          <HeaderDropdown key={group.title} label={group.title === "Analyze" ? "Tools" : "Monitoring"}
            active={group.items.some((item) => isActive(pathname, item.href))}>
            {group.items.map((item) => <NavLink key={item.href} href={item.href} className="header-menu-link">{item.label}</NavLink>)}
          </HeaderDropdown>
        ))}
      </nav>
      <details key={pathname} className="order-last basis-full text-[14px] lg:hidden">
        <summary className="cursor-pointer list-none rounded border px-3 py-2 font-medium border-border [&::-webkit-details-marker]:hidden">
          Menu <span aria-hidden="true" className="float-right">＋</span>
        </summary>
        <nav aria-label="Main" className="mt-2 space-y-4 pb-2">
          {groups.map((group) => (
            <div key={group.title}>
              <p className="px-3 text-[13px] font-medium text-muted">{group.title === "Analyze" ? "Tools" : group.title === "Monitor" ? "Monitoring" : group.title}</p>
              <ul className="flex flex-col">{group.items.map((item) => (
                <li key={item.href}><NavLink href={item.href} className="header-menu-link">{item.label}</NavLink></li>
              ))}</ul>
            </div>
          ))}
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
