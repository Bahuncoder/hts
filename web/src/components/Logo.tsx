/** The HTSDesk mark: four indents descending to the statistical line.
 *
 *  An HTS code is a hierarchy read as a number — chapter, heading,
 *  subheading, statistical line — and that is what the mark draws. The last
 *  rung is copper because the last rung is where the money is decided.
 *  At favicon size the third rung drops out and the mark still reads.
 */
export function Mark({
  size = 23,
  tone = "accent",
}: {
  size?: number;
  tone?: "accent" | "deep" | "solid";
}) {
  const base =
    tone === "deep"
      ? "#5fc0a5"
      : tone === "solid"
        ? "#ffffff"
        : "var(--accent)";
  const flag =
    tone === "deep"
      ? "#e08a4e"
      : tone === "solid"
        ? "#f0a06a"
        : "var(--recover)";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 104 76"
      fill="none"
      aria-hidden="true"
    >
      <rect x="0" y="4" width="96" height="11" rx="1.5" fill={base} />
      <rect
        x="14"
        y="24"
        width="74"
        height="11"
        rx="1.5"
        fill={base}
        opacity="0.74"
      />
      <rect
        x="28"
        y="44"
        width="52"
        height="11"
        rx="1.5"
        fill={base}
        opacity="0.5"
      />
      <rect x="42" y="64" width="30" height="11" rx="1.5" fill={flag} />
    </svg>
  );
}

export function Wordmark({ size = 17 }: { size?: number }) {
  return (
    <span
      style={{ fontSize: size, fontWeight: 600, letterSpacing: "-0.015em" }}
    >
      HTS<span style={{ color: "var(--muted)", fontWeight: 450 }}>Desk</span>
    </span>
  );
}

export function Lockup({
  mark = 23,
  word = 17,
}: {
  mark?: number;
  word?: number;
}) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
      <Mark size={mark} />
      <Wordmark size={word} />
    </span>
  );
}
