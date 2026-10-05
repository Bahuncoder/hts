"use client";

import { useEffect, useState } from "react";

export type SettingsSection = { id: string; label: string };

/** The account settings menu. It marks the section you are reading, so the
 *  menu always says where you are, not only where the mouse last was. */
export default function SettingsNav({ sections }: { sections: SettingsSection[] }) {
  const [current, setCurrent] = useState(sections[0]?.id ?? "");

  useEffect(() => {
    const update = () => {
      // The current section is the last one whose top has reached the upper
      // third of the screen. At the foot of the page, that is the last section.
      const line = window.innerHeight * 0.35;
      let next = sections[0]?.id ?? "";
      for (const s of sections) {
        const el = document.getElementById(s.id);
        if (el && el.getBoundingClientRect().top <= line) next = s.id;
      }
      const atEnd = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
      if (atEnd && sections.length) next = sections[sections.length - 1].id;
      setCurrent(next);
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
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
