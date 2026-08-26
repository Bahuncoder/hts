"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { PlanId } from "@/lib/plans";

async function go(url: string, body?: unknown): Promise<string> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.url) throw new Error(data.error ?? "Could not reach billing.");
  return data.url as string;
}

export function SubscribeButton({
  plan, label, signedIn, primary = false, onDark = false,
}: { plan: PlanId; label: string; signedIn: boolean; primary?: boolean; onDark?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // On the dark plan card the light surface style reads as a hole punched in
  // the panel; the accent belongs there instead.
  const style = primary || onDark
    ? { background: "var(--accent)", color: "var(--on-accent)", border: "1px solid var(--accent)" }
    : { background: "var(--surface)", color: "var(--ink)", border: "1px solid var(--rule)" };

  return (
    <div className="space-y-2">
      <button
        disabled={busy}
        onClick={async () => {
          if (!signedIn) { router.push(`/signup?plan=${plan}`); return; }
          setBusy(true); setError(null);
          try { window.location.href = await go("/api/billing/checkout", { plan }); }
          catch (e) { setError(e instanceof Error ? e.message : "Something went wrong."); setBusy(false); }
        }}
        className="w-full py-2.5 text-[14px] font-medium disabled:opacity-60"
        style={style}
      >
        {busy ? "Opening checkout…" : label}
      </button>
      {error ? <p className="text-[12px]" style={{ color: "var(--danger)" }}>{error}</p> : null}
    </div>
  );
}

export function PortalButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true); setError(null);
          try { window.location.href = await go("/api/billing/portal"); }
          catch (e) { setError(e instanceof Error ? e.message : "Something went wrong."); setBusy(false); }
        }}
        className="px-4 py-2 text-[14px] font-medium disabled:opacity-60"
        style={{ border: "1px solid var(--rule)", background: "var(--surface)" }}
      >
        {busy ? "Opening…" : "Manage billing"}
      </button>
      {error ? <p className="text-[12px]" style={{ color: "var(--danger)" }}>{error}</p> : null}
    </div>
  );
}
