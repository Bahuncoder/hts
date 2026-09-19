"use client";

import Link from "next/link";

/** Shown when a page throws while rendering. This is the boundary for the
 *  segment below the root layout; it keeps the header and footer. Next 16
 *  passes `retry` (re-fetch and re-render the segment) as the way back;
 *  `reset` only clears the boundary without re-fetching, so it is the wrong
 *  tool for a failed server render. */
export default function ErrorPage({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <div role="alert" className="max-w-xl space-y-4">
      <h1 className="text-3xl font-semibold tracking-tight">
        Something went wrong
      </h1>
      <p className="text-muted">
        This page could not be shown. It is usually temporary, and nothing you
        have saved was changed. Try again, or come back in a minute.
      </p>
      <div className="flex flex-wrap items-center gap-4">
        <button
          type="button"
          onClick={() => retry()}
          className="rounded-md px-4 py-2 text-[15px] font-medium bg-accent text-on-accent"
        >
          Try again
        </button>
        <Link href="/" className="hover:underline text-accent">
          Go to the home page
        </Link>
      </div>
      {error.digest ? (
        <p className="text-[12px] text-faint">
          If it keeps happening, quote reference{" "}
          <span className="mono">{error.digest}</span>.
        </p>
      ) : null}
    </div>
  );
}
