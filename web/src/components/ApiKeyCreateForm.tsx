"use client";

import { startTransition, useActionState, useState } from "react";
import { createApiKeyAction, type ApiKeyFormState } from "@/lib/actions";

/** Creates a key and shows its secret exactly once, inline -- never via a
 *  redirect or query string, which would leak it into browser history and
 *  server access logs. Once this component unmounts (a re-render after the
 *  next action, or a page navigation) the secret is gone for good, matching
 *  what the server itself guarantees: it is never stored or retrievable. */
export function ApiKeyCreateForm() {
  const [state, formAction, pending] = useActionState<ApiKeyFormState, FormData>(
    createApiKeyAction, {},
  );
  const [copied, setCopied] = useState(false);

  if (state.created) {
    const { secret, prefix } = state.created;
    return (
      <div className="space-y-3 rounded border-l-2 border-accent bg-accent-soft p-4">
        <p className="text-[14px] font-medium text-accent">
          Key created — copy it now. It will not be shown again.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <code className="mono select-all break-all rounded border border-rule bg-surface px-3 py-2 text-[13px]">
            {secret}
          </code>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(secret);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              } catch { /* clipboard unavailable; the text above is select-all */ }
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <p className="text-[12px] text-faint">Shown as {prefix}… in your key list from now on.</p>
      </div>
    );
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        startTransition(() => { formAction(data); });
      }}
      className="flex flex-wrap items-end gap-3"
    >
      <label className="block space-y-1.5">
        <span className="lbl">Key name</span>
        <input
          name="name"
          placeholder="e.g. production integration"
          maxLength={100}
          className="field-control"
          style={{ borderColor: "var(--rule)", background: "var(--surface)", color: "var(--ink)" }}
        />
      </label>
      <button type="submit" disabled={pending} className="btn btn-primary">
        {pending ? "Creating…" : "Create key"}
      </button>
      {state.error ? <p role="alert" className="w-full text-[13px] text-danger">{state.error}</p> : null}
    </form>
  );
}
