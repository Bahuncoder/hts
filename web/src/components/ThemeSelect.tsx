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
export function ThemeSelect() {
  const value = useSyncExternalStore(subscribe, read, () => "system" as ThemeChoice);
  return (
    <label className="flex items-center gap-2 text-[13px] text-muted">
      <span className="sr-only sm:not-sr-only">Theme</span>
      <select
        aria-label="Theme"
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
