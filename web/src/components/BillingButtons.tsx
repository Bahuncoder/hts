"use client";

import { useState } from "react";
import type { PlanId } from "@/lib/plans";

async function goTo(path: string, opts: RequestInit, setError: (e: string | null) => void) {
  setError(null);
  try {
    const res = await fetch(path, opts);
    const data = (await res.json().catch(() => null)) as { url?: string; error?: string } | null;
    if (!res.ok || !data?.url) {
      setError(data?.error ?? "Something went wrong. Try again shortly.");
      return;
    }
    window.location.href = data.url;
  } catch {
    setError("Something went wrong. Try again shortly.");
  }
}

export function SubscribeButton({
  plan, signedIn, primary, label,
}: {
  plan: PlanId;
  signedIn: boolean;
  primary?: boolean;
  label: string;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!signedIn) {
    return (
      <a href={`/signup?next=/pricing`} className={`btn ${primary ? "btn-primary" : "btn-secondary"} w-full`}>
        {label}
      </a>
    );
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled={pending}
        className={`btn ${primary ? "btn-primary" : "btn-secondary"} w-full`}
        onClick={async () => {
          setPending(true);
          await goTo("/api/billing/checkout", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ plan }),
          }, setError);
          setPending(false);
        }}
      >
        {pending ? "Starting checkout…" : label}
      </button>
      {error ? <p role="alert" className="text-[13px] text-danger">{error}</p> : null}
    </div>
  );
}

export function PortalButton({ className = "btn btn-secondary" }: { className?: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled={pending}
        className={className}
        onClick={async () => {
          setPending(true);
          await goTo("/api/billing/portal", { method: "POST" }, setError);
          setPending(false);
        }}
      >
        {pending ? "Opening billing…" : "Manage billing"}
      </button>
      {error ? <p role="alert" className="text-[13px] text-danger">{error}</p> : null}
    </div>
  );
}
