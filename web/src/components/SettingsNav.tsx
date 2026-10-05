"use client";

import { useEffect, useState } from "react";

export type SettingsSection = { id: string; label: string };

/** The account settings menu. Each item opens its own section; the section
 *  the link names is the one shown (see the settings rules in globals.css),
 *  and the menu marks it. With no section named, Profile is shown. */
export default function SettingsNav({ sections }: { sections: SettingsSection[] }) {
  const [current, setCurrent] = useState(sections[0]?.id ?? "");

  useEffect(() => {
    const fromHash = () => {
      const id = window.location.hash.slice(1);
      setCurrent(sections.some((s) => s.id === id) ? id : sections[0]?.id ?? "");
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, [sections]);

  return (
    <nav aria-label="Settings sections" className="settings-nav">
      {sections.map((s) => (
        <a
          key={s.id}
          href={`#${s.id}`}
          aria-current={current === s.id ? "location" : undefined}
          className={current === s.id ? "settings-nav-current" : undefined}
        >
          {s.label}
        </a>
      ))}
    </nav>
  );
}
