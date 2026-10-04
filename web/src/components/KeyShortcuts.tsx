"use client";

import { useEffect } from "react";

/** "/" moves to the page's main search field; "Esc" closes the header menu and,
 *  from inside a field, leaves it. Neither fires while typing elsewhere. */
export function KeyShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
      if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const field = document.querySelector<HTMLInputElement>("[data-search]");
        if (field) { e.preventDefault(); field.focus(); }
      }
      if (e.key === "Escape") {
        document.querySelectorAll<HTMLDetailsElement>("header details[open]").forEach((d) => { d.open = false; });
        if (typing && t) t.blur();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  return null;
}
