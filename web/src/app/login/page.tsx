import { redirect } from "next/navigation";
import { AuthForm, AuthFooterLink } from "@/components/AuthForm";
import { loginAction } from "@/lib/actions";
import { currentViewer } from "@/lib/auth";
import { nextQuery, safeNext } from "@/lib/next";

export const metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  // Only an allowlisted destination survives (lib/next.ts); anything else is
  // dropped and the default is used.
  const next = safeNext((await searchParams).next);
  if (await currentViewer()) redirect(next ?? "/account");
  return (
    <AuthForm
      action={loginAction}
      submit="Sign in"
      heading="Sign in"
      blurb="Your catalogues and watched codes are waiting."
      hidden={next ? { next } : undefined}
      footer={
        <>
          <AuthFooterLink href="/forgot">Forgot your password?</AuthFooterLink>
          <br />
          No account yet?{" "}
          <AuthFooterLink href={`/signup${nextQuery(next)}`}>Create one</AuthFooterLink>.
        </>
      }
    />
  );
}
