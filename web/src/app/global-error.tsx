"use client";

import "./globals.css";

/** Last resort: the root layout itself failed (for example the account store
 *  was unreachable while it looked up the signed-in visitor). It replaces the
 *  layout, so it brings its own document and styles. */
export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <html lang="en">
      <body>
        <main className="mx-auto max-w-xl space-y-4 px-4 py-16">
          <title>HTSDesk — temporarily unavailable</title>
          <h1 className="text-3xl font-semibold tracking-tight">
            HTSDesk is temporarily unavailable
          </h1>
          <p className="text-muted">
            The site could not load just now. Nothing you have saved was
            changed. Try again in a minute.
          </p>
          <button
            type="button"
            onClick={() => retry()}
            className="rounded-md px-4 py-2 text-[15px] font-medium bg-accent text-on-accent"
          >
            Try again
          </button>
          {error.digest ? (
            <p className="text-[12px] text-faint">
              Reference <span className="mono">{error.digest}</span>
            </p>
          ) : null}
        </main>
      </body>
    </html>
  );
}
