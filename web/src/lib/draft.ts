/** A catalogue draft that survives sign-up, kept only in this browser.
 *
 *  Privacy model, in one place:
 *  - Stored in localStorage under one key. It is never sent to the server and
 *    never sent anywhere else.
 *  - It holds the catalogue TEXT and the two assumption settings, nothing the
 *    engine produced: no results, no proofs. Signed results expire and would be
 *    stale; the customer re-runs, and chooses to, because running spends their
 *    allowance.
 *  - It expires after 24 hours. Every read checks the age and deletes an
 *    expired or unreadable draft.
 *  - It is written only for an anonymous visitor (who has no other way to
 *    carry work across sign-up) and only for their own text, never the sample.
 *  - It is deleted on sign-out, on discard, after a restore and after a save.
 *  - Every storage access is wrapped: private windows, a full quota or
 *    disabled storage make the draft silently unavailable and nothing else.
 *
 *  Client-only: nothing here may be imported by server code.
 */

export const DRAFT_KEY = "htsdesk.draft.v1";
export const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
/** Same ceiling the import panel applies to a file. */
const MAX_TEXT = 1_900_000;

export type Draft = {
  text: string;
  /** Formal entries the value is spread over. */
  entries: number;
  transport: "vessel" | "air";
  /** Epoch milliseconds. */
  savedAt: number;
  /** Data rows in the text, for the notice. */
  rows: number;
};

/** Fired on the window after this tab changes the draft, so components in the
 *  same tab update. (`storage` events only reach other tabs.) */
const CHANGED = "htsdesk:draft";

function store(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Parses and validates a stored value. Null when it is not a usable draft. */
export function parseDraft(raw: string | null, now = Date.now()): Draft | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as Partial<Draft> | null;
    if (!d || typeof d !== "object") return null;
    if (typeof d.text !== "string" || !d.text.trim() || d.text.length > MAX_TEXT) return null;
    if (typeof d.savedAt !== "number" || !Number.isFinite(d.savedAt)) return null;
    if (d.transport !== "vessel" && d.transport !== "air") return null;
    if (typeof d.entries !== "number" || !Number.isFinite(d.entries)) return null;
    if (typeof d.rows !== "number" || !Number.isFinite(d.rows)) return null;
    const age = now - d.savedAt;
    if (age > DRAFT_TTL_MS || age < -5 * 60_000) return null; // expired, or from a clock far in the future
    return {
      text: d.text,
      entries: Math.max(1, Math.min(100_000, Math.floor(d.entries))),
      transport: d.transport,
      savedAt: d.savedAt,
      rows: Math.max(0, Math.floor(d.rows)),
    };
  } catch {
    return null;
  }
}

/** The raw stored string, for `useSyncExternalStore`. Never throws. */
export function readRawDraft(): string | null {
  try {
    return store()?.getItem(DRAFT_KEY) ?? null;
  } catch {
    return null;
  }
}

function announce() {
  try {
    window.dispatchEvent(new Event(CHANGED));
  } catch { /* no window */ }
}

export function subscribeDraft(callback: () => void): () => void {
  window.addEventListener(CHANGED, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(CHANGED, callback);
    window.removeEventListener("storage", callback);
  };
}

/** The current draft, or null. An expired or corrupt one is deleted. */
export function readDraft(now = Date.now()): Draft | null {
  const raw = readRawDraft();
  if (raw === null) return null;
  const d = parseDraft(raw, now);
  if (!d) clearDraft();
  return d;
}

export function clearDraft(): void {
  try {
    store()?.removeItem(DRAFT_KEY);
  } catch { /* storage unavailable: nothing to clear */ }
  announce();
}

/** Rows in a catalogue text: non-blank lines after the header. */
export function countRows(text: string): number {
  const lines = text.split(/\r\n|\n|\r/).filter((l) => l.trim());
  return Math.max(0, lines.length - 1);
}

/** Stores a draft. Returns whether it was stored. Empty text is never stored,
 *  and the caller is responsible for not passing the sample. */
export function writeDraft(input: {
  text: string;
  entries: number;
  transport: "vessel" | "air";
  rows?: number;
}): boolean {
  if (!input.text.trim() || input.text.length > MAX_TEXT) return false;
  const draft: Draft = {
    text: input.text,
    entries: Math.max(1, Math.min(100_000, Math.floor(input.entries) || 1)),
    transport: input.transport,
    savedAt: Date.now(),
    rows: input.rows ?? countRows(input.text),
  };
  try {
    const s = store();
    if (!s) return false;
    s.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    return false; // quota, or storage disabled
  }
  announce();
  return true;
}

/** "just now", "12 minutes ago", "3 hours ago". */
export function agoLabel(savedAt: number, now = Date.now()): string {
  const mins = Math.max(0, Math.floor((now - savedAt) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.floor(mins / 60);
  return `${hours} hour${hours === 1 ? "" : "s"} ago`;
}
