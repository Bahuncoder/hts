import Link from "next/link";

export function Card({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`panel p-5 sm:p-6 ${className}`}
    >
      {children}
    </div>
  );
}

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "good" | "warn" | "bad";
  children: React.ReactNode;
}) {
  const tones = {
    neutral: {
      background: "var(--surface)",
      color: "var(--muted)",
      borderColor: "var(--border)",
    },
    good: {
      background: "var(--accent-soft)",
      color: "var(--accent)",
      borderColor: "transparent",
    },
    warn: {
      background: "var(--caution-soft)",
      color: "var(--caution)",
      borderColor: "transparent",
    },
    bad: {
      background: "var(--caution-soft)",
      color: "var(--danger)",
      borderColor: "transparent",
    },
  }[tone];
  return (
    <span
      className="inline-block rounded border px-1.5 py-0.5 text-[12px] font-medium"
      style={tones}
    >
      {children}
    </span>
  );
}

export function Stat({
  label,
  value,
  sub,
  tone,
  flag,
  children,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "good" | "warn" | "recover";
  /** A visible text marker beside the figure, for a number that must not be
   *  read as final. Colour alone never carries this. */
  flag?: string;
  /** Detail that belongs directly under the figure, e.g. why it is flagged. */
  children?: React.ReactNode;
}) {
  const color =
    tone === "warn"
      ? "var(--caution)"
      : tone === "recover"
        ? "var(--recover)"
        : tone === "good"
          ? "var(--accent)"
          : "var(--ink)";
  return (
    <div>
      <div className="lbl">
        {label}
      </div>
      <div className="mono mt-2 text-2xl font-medium" style={{ color }}>
        {value}
      </div>
      {flag ? (
        <div className="mt-1">
          <Badge tone="warn">{flag}</Badge>
        </div>
      ) : null}
      {sub ? <div className="text-[12px] text-muted">{sub}</div> : null}
      {children}
    </div>
  );
}

export function HtsLink({ code }: { code: string }) {
  return (
    <Link
      href={`/hts/${code}`}
      className="tabular font-medium hover:underline text-accent"
    >
      {code}
    </Link>
  );
}

export function Note({
  children,
  role,
}: {
  children: React.ReactNode;
  role?: "alert" | "status";
}) {
  return (
    <p
      role={role}
      className="rounded border-l-2 py-2 pl-3 text-[13px] border-caution bg-caution-soft text-caution"
    >
      {children}
    </p>
  );
}
