"use client";

import { useActionState } from "react";
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
}: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  submit: string;
  heading: string;
  blurb: string;
  footer: React.ReactNode;
  hidden?: Record<string, string>;
  emailOnly?: boolean;
  newPassword?: boolean;
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

      <form action={formAction} className="space-y-4">
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
            />
            {newPassword ? (
              <span className="block text-[12px] text-faint">
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
