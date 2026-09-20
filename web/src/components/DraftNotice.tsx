"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import Link from "next/link";
import { logoutAction } from "@/lib/actions";
import {
  agoLabel, clearDraft, parseDraft, readRawDraft, subscribeDraft, type Draft,
} from "@/lib/draft";

/** The saved draft, or null. Reads on the client only: the server snapshot is
 *  always null, so nothing here can differ between server and first client
 *  render. An expired or corrupt value is deleted (lib/draft.ts). */
export function useSavedDraft(): Draft | null {
  const raw = useSyncExternalStore(subscribeDraft, readRawDraft, () => null);
  const draft = useMemo(() => parseDraft(raw), [raw]);
  useEffect(() => {
    if (raw !== null && draft === null) clearDraft();
  }, [raw, draft]);
  return draft;
}

/** "You have an unsaved catalogue from earlier". Restoring is always the
 *  visitor's action; nothing here runs an audit. */
export function DraftNotice({
  draft, onRestore, continueHref, onDiscard,
}: {
  draft: Draft;
  /** Fills the import form. Mutually exclusive with `continueHref`. */
  onRestore?: () => void;
  /** Where "Continue to audit" goes, on pages that cannot restore in place. */
  continueHref?: string;
  onDiscard: () => void;
}) {
  return (
    <section
      aria-label="Unsaved catalogue"
      data-testid="draft-notice"
      className="rounded-md border border-border border-l-2 border-l-accent bg-accent-soft p-4 sm:p-5"
    >
      <p className="text-[15px] font-medium">
        You have an unsaved catalogue from earlier{" "}
        <span className="font-normal text-muted">
          ({draft.rows.toLocaleString()} {draft.rows === 1 ? "row" : "rows"}, saved {agoLabel(draft.savedAt)})
        </span>
        .
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {onRestore ? (
          <button type="button" onClick={onRestore} className="btn btn-primary">
            Restore it
          </button>
        ) : null}
        {continueHref ? (
          <Link href={continueHref} className="btn btn-primary">
            Continue to audit
          </Link>
        ) : null}
        <button type="button" onClick={onDiscard} className="btn btn-secondary">
          Discard
        </button>
      </div>
      <p className="mt-3 text-[13px] text-muted">
        Kept only in this browser for 24 hours; cleared when you sign out. Restoring fills the form and does not run
        the audit.
      </p>
    </section>
  );
}

/** The /account shell is a server component; this is its one client piece. */
export function AccountDraftBanner() {
  const draft = useSavedDraft();
  if (!draft) return null;
  return <DraftNotice draft={draft} continueHref="/audit" onDiscard={clearDraft} />;
}

/** Signing out deletes the draft, so supplier data does not sit in the
 *  browser for the next person to sign in on a shared computer. The server
 *  action ends the session; clearing storage can only happen here. */
export function SignOutForm() {
  return (
    <form action={logoutAction} onSubmit={() => clearDraft()}>
      <button className="btn btn-secondary">Sign out</button>
    </form>
  );
}
