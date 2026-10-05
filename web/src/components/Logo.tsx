/** A bold H inside a clipped document: classification, evidence, and a desk. */
export function Mark({ size = 28, tone = "accent" }: {
  size?: number;
  tone?: "accent" | "deep" | "solid";
}) {
  const base = tone === "deep" ? "#5fc0a5" : tone === "solid" ? "#ffffff" : "var(--accent)";
  const ink = tone === "deep" || tone === "solid" ? "#10201c" : "var(--paper)";
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true" focusable="false">
      <path d="M8 2H23L30 9V24C30 27.314 27.314 30 24 30H8C4.686 30 2 27.314 2 24V8C2 4.686 4.686 2 8 2Z" fill={base} />
      <path d="M8 9H12V14H20V9H24V23H20V18H12V23H8V9Z" fill={ink} />
    </svg>
  );
}

export function Wordmark({ size = 18 }: { size?: number }) {
  return (
    <span style={{ fontSize: size, fontWeight: 600, letterSpacing: "-0.035em", lineHeight: 1 }}>
      HTSDesk
    </span>
  );
}

export function Lockup({ mark = 28, word = 18 }: { mark?: number; word?: number }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 9, whiteSpace: "nowrap" }}>
      <Mark size={mark} />
      <Wordmark size={word} />
    </span>
  );
}
