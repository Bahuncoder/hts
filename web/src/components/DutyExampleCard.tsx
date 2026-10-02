/** The illustrative duty-breakdown card shown in a marketing hero. Shared by
 *  the homepage and the China-tariffs landing page, which otherwise
 *  duplicated this markup verbatim except for the heading label and the
 *  line items themselves. */
export default function DutyExampleCard({
  heading, lines, edition,
}: {
  heading: string;
  lines: [string, string][];
  /** The live reference-data edition, when the engine is reachable — a
   *  quiet, honest "this is current" signal, not a liveness claim. */
  edition?: string;
}) {
  return (
    <div className="hero-example" aria-label="Illustrative duty breakdown, not a live quote">
      <div className="flex items-center justify-between border-b border-border px-6 py-4">
        <span className="lbl">{heading}</span>
        <span className="rounded bg-sunk px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted">Example</span>
      </div>
      <div className="p-6 sm:p-8">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium">Cotton T-shirt</p>
            <p className="mono mt-1 text-xs text-faint">China · $10,000 entered value</p>
          </div>
          <span className="rounded-full bg-caution-soft px-2.5 py-1 text-xs text-caution-ink">Review needed</span>
        </div>
        <div className="mt-7 space-y-4 text-sm">
          {lines.map(([label, amount]) => (
            <div key={label} className="flex justify-between gap-3">
              <span className="text-muted">{label}</span><span className="mono">{amount}</span>
            </div>
          ))}
        </div>
        <div className="mt-6 flex items-end justify-between gap-4 border-t border-rule pt-5">
          <div><p className="lbl">Illustrative subtotal</p><p className="mt-1 text-xs text-muted">Before unresolved duties</p></div>
          <p className="mono text-2xl font-medium text-accent">$2,447.14</p>
        </div>
        <p className="mt-5 rounded-md border-l-2 border-caution bg-caution-soft p-3 text-xs leading-relaxed text-caution-ink">
          An unresolved scope is kept visible, so you know what to confirm before relying on a figure.
        </p>
      </div>
      <div className="border-t border-border bg-sunk px-6 py-3 text-xs text-muted">
        <p>Illustration only. Run a calculation for your goods and current data.</p>
        {edition ? <p className="mt-1">✓ Reference edition: {edition}</p> : null}
      </div>
    </div>
  );
}
