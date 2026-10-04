import type { ReactNode } from "react";
import Link from "next/link";

/** What an empty or gated screen says, in the same order every time: a title
 *  that names the state, a short explanation, and one clear next step. */
export default function EmptyState({
  title, children, action, secondary,
}: {
  title: string;
  children: ReactNode;
  action?: { href: string; label: string };
  secondary?: { href: string; label: string };
}) {
  return (
    <section className="panel px-5 py-8 sm:px-8" aria-labelledby="empty-title">
      <h2 id="empty-title" className="serif text-2xl tracking-tight">{title}</h2>
      <div className="mt-3 max-w-2xl space-y-3 text-[15px] text-muted">{children}</div>
      {action || secondary ? (
        <div className="mt-6 flex flex-wrap gap-3">
          {action ? <Link href={action.href} className="btn btn-primary">{action.label}</Link> : null}
          {secondary ? <Link href={secondary.href} className="btn btn-secondary">{secondary.label}</Link> : null}
        </div>
      ) : null}
    </section>
  );
}
