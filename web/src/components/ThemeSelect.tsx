"use client";

import { useSyncExternalStore } from "react";

export type ThemeChoice = "system" | "light" | "dark";
const KEY = "htsdesk.theme";
const EVENT = "htsdesk:theme";

function read(): ThemeChoice {
  try {
    const v = window.localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

function subscribe(onChange: () => void) {
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

function apply(choice: ThemeChoice) {
  const root = document.documentElement;
  if (choice === "system") delete root.dataset.theme;
  else root.dataset.theme = choice;
  try {
    if (choice === "system") window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, choice);
  } catch { /* storage unavailable: the choice still applies for this page */ }
  window.dispatchEvent(new Event(EVENT));
}

/** Light, dark or the system setting. The choice is applied before first paint
 *  by the script in the root layout, so a stored preference never flashes. */
export function ThemeSelect({ id, label = "Theme", showLabel = false, variant = "select" }: { id?: string; label?: string; showLabel?: boolean; variant?: "select" | "choices" } = {}) {
  const value = useSyncExternalStore(subscribe, read, () => "system" as ThemeChoice);
  if (variant === "choices") {
    return (
      <div className="theme-choices" role="group" aria-label="Appearance">
        {(["light", "dark", "system"] as const).map((choice) => (
          <button key={choice} type="button" aria-pressed={value === choice}
            onClick={() => apply(choice)} className="theme-choice">
            <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              {choice === "light" ? <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></> : choice === "dark" ? <path d="M20 15.5A9 9 0 0 1 8.5 4 9 9 0 1 0 20 15.5Z" /> : <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8m-4-4v4" /></>}
            </svg>
            {choice === "system" ? "System" : choice === "light" ? "Light" : "Dark"}
          </button>
        ))}
      </div>
    );
  }
  return (
    <label className="flex items-center gap-2 text-[13px] text-muted">
      <span className={showLabel ? undefined : "sr-only sm:not-sr-only"}>{label}</span>
      <select
        id={id}
        aria-label={label}
        value={value}
        onChange={(e) => apply(e.target.value as ThemeChoice)}
        style={{ width: "auto", minHeight: 36 }}
        className="rounded border border-border bg-surface px-2 py-1 text-[13px] text-ink"
      >
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  );
}
