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
      className={`rounded-lg border p-5 ${className} border-border bg-surface`}
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
      className="inline-block rounded border px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide"
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
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "good" | "warn";
}) {
  const color =
    tone === "warn"
      ? "var(--caution)"
      : tone === "good"
        ? "var(--accent)"
        : "var(--ink)";
  return (
    <div>
      <div className="text-[12px] uppercase tracking-wide text-muted">
        {label}
      </div>
      <div className="tabular mt-1 text-2xl font-semibold" style={{ color }}>
        {value}
      </div>
      {sub ? <div className="text-[12px] text-muted">{sub}</div> : null}
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

export function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded border-l-2 py-2 pl-3 text-[13px] border-caution bg-caution-soft text-caution">
      {children}
    </p>
  );
}
