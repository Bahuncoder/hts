"use client";

import { useState } from "react";

/** Copies a code to the clipboard and says so. Silent failure is not an option:
 *  if the clipboard is unavailable the button says it could not copy. */
export function CopyButton({ value, label = "Copy code" }: { value: string; label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <button
      type="button"
      className="btn btn-secondary"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setState("copied");
        } catch {
          setState("failed");
        }
        setTimeout(() => setState("idle"), 2000);
      }}
      aria-live="polite"
    >
      {state === "copied" ? "Copied" : state === "failed" ? "Could not copy" : label}
    </button>
  );
}
