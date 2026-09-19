/** Shown instantly while a page's data streams in. Structure only — no
 *  invented progress — and announced once to assistive technology. */
export default function Loading() {
  return (
    <div role="status" aria-live="polite" className="space-y-6">
      <span className="sr-only">Loading…</span>
      <div aria-hidden="true" className="space-y-3">
        <div className="h-8 w-64 rounded bg-sunk motion-safe:animate-pulse" />
        <div className="h-4 w-full max-w-xl rounded bg-sunk motion-safe:animate-pulse" />
        <div className="h-4 w-2/3 max-w-lg rounded bg-sunk motion-safe:animate-pulse" />
      </div>
      <div aria-hidden="true" className="grid gap-5 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-24 rounded-lg border border-border bg-surface motion-safe:animate-pulse"
          />
        ))}
      </div>
    </div>
  );
}
