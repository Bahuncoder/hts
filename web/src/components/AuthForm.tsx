"use client";

import { startTransition, useActionState } from "react";
import Link from "next/link";
import type { FormState } from "@/lib/actions";

export function AuthForm({
  action,
  submit,
  heading,
  blurb,
  footer,
  hidden,
  emailOnly,
  newPassword,
  googleHref,
}: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  submit: string;
  heading: string;
  blurb: string;
  footer: React.ReactNode;
  hidden?: Record<string, string>;
  emailOnly?: boolean;
  newPassword?: boolean;
  /** The full "/api/auth/google?next=…" link, computed by the caller — the
   *  route itself checks GOOGLE_CLIENT_ID/SECRET and 404s if unconfigured, so
   *  this is only passed once the caller already knows Google sign-in is on. */
  googleHref?: string;
}) {
  const [state, formAction, pending] = useActionState(action, {} as FormState);
  const field = {
    borderColor: "var(--rule)",
    background: "var(--surface)",
    color: "var(--ink)",
  };

  return (
    <div className="panel mx-auto my-5 max-w-[460px] space-y-6 p-6 sm:my-10 sm:p-9">
      <div className="space-y-2">
        <p className="eyebrow mb-4">Your HTSDesk workspace</p>
        <h1 className="serif text-4xl tracking-tight">{heading}</h1>
        <p className="text-[15px] text-muted">{blurb}</p>
      </div>

      {googleHref ? (
        <>
          <a href={googleHref} className="btn btn-secondary w-full">
            <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
              <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.9c1.7-1.56 2.7-3.87 2.7-6.62z" />
              <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.8.54-1.84.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.95v2.33A9 9 0 0 0 9 18z" />
              <path fill="#FBBC05" d="M3.95 10.7A5.4 5.4 0 0 1 3.67 9c0-.59.1-1.16.28-1.7V4.97H.95A9 9 0 0 0 0 9c0 1.45.35 2.83.95 4.03l3-2.33z" />
              <path fill="#EA4335" d="M9 3.58c1.32 0 2.51.46 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .95 4.97l3 2.33C4.66 5.17 6.65 3.58 9 3.58z" />
            </svg>
            Continue with Google
          </a>
          <div className="flex items-center gap-3 text-[12px] text-faint" role="separator" aria-label="or">
            <span className="h-px flex-1" style={{ background: "var(--rule)" }} />
            or
            <span className="h-px flex-1" style={{ background: "var(--rule)" }} />
          </div>
        </>
      ) : null}

      <form
        // Submitting the native way (action={formAction}) stops resubmitting
        // after a first non-revalidating response in this Next.js build (a
        // failed sign-in returns only its error, with no page re-render, and
        // the client's sequential action dispatcher never unblocks for the
        // next submit). Driving the same action explicitly, from a fresh
        // FormData snapshot on every submit, sidesteps whatever state that
        // native binding gets stuck in.
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          startTransition(() => {
            formAction(data);
          });
        }}
        className="space-y-4"
      >
        {Object.entries(hidden ?? {}).map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
        {!hidden?.token ? (
          <label className="block space-y-1.5">
            <span className="lbl">Email</span>
            <input
              name="email"
              type="email"
              required
              autoComplete="email"
              className="field-control"
              style={field}
            />
          </label>
        ) : null}
        {!emailOnly ? (
          <label className="block space-y-1.5">
            <span className="lbl">
              {newPassword ? "New password" : "Password"}
            </span>
            <input
              name="password"
              type="password"
              required
              minLength={10}
              autoComplete={newPassword ? "new-password" : "current-password"}
              className="field-control"
              style={field}
              // The wrapping label also contains the hint text below, which
              // would otherwise run into this field's accessible name (a
              // screen reader announcing "New password At least 10
              // characters" as the field's name, not its description). An
              // explicit label keeps the name exactly "New password" /
              // "Password"; the hint stays linked as a description.
              aria-label={newPassword ? "New password" : "Password"}
              aria-describedby={newPassword ? "new-password-hint" : undefined}
            />
            {newPassword ? (
              <span id="new-password-hint" className="block text-[12px] text-faint">
                At least 10 characters.
              </span>
            ) : null}
          </label>
        ) : null}

        {state.error ? (
          <p role="alert" className="border-l-2 py-2 pl-3 text-[13px] border-danger bg-caution-soft text-danger">
            {state.error}
          </p>
        ) : null}
        {state.notice ? (
          <p role="status" className="border-l-2 py-2 pl-3 text-[13px] border-accent bg-accent-soft text-accent">
            {state.notice}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={pending}
          className="btn btn-primary w-full"
        >
          {pending ? "Working…" : submit}
        </button>
      </form>

      <p className="text-[14px] text-muted">{footer}</p>
    </div>
  );
}

export function AuthFooterLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link href={href} className="hover:underline text-accent">
      {children}
    </Link>
  );
}
