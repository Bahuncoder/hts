import { redirect } from "next/navigation";
import { AuthForm, AuthFooterLink } from "@/components/AuthForm";
import { loginAction } from "@/lib/actions";
import { currentViewer } from "@/lib/auth";
import { googleEnabled } from "@/lib/googleAuth";
import { nextQuery, safeNext } from "@/lib/next";

export const metadata = { title: "Sign in" };

const OAUTH_ERRORS: Record<string, string> = {
  oauth: "Something went wrong signing in with Google. Please try again.",
  oauth_cancelled: "Google sign-in was cancelled.",
  oauth_unverified: "That Google account's email isn't verified yet. Verify it with Google, then try again.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[]; error?: string }>;
}) {
  // Only an allowlisted destination survives (lib/next.ts); anything else is
  // dropped and the default is used.
  const { next: rawNext, error } = await searchParams;
  const next = safeNext(rawNext);
  if (await currentViewer()) redirect(next ?? "/account");
  const oauthError = error ? OAUTH_ERRORS[error] ?? OAUTH_ERRORS.oauth : null;
  return (
    <>
      {oauthError ? (
        <p className="mx-auto mt-8 max-w-[400px] border-l-2 py-2 pl-3 text-[13px] border-caution bg-caution-soft text-caution-ink">
          {oauthError}
        </p>
      ) : null}
      <AuthForm
        action={loginAction}
        submit="Sign in"
        heading="Sign in"
        blurb="Your catalogues and watched codes are waiting."
        hidden={next ? { next } : undefined}
        googleHref={googleEnabled() ? `/api/auth/google${nextQuery(next)}` : undefined}
        footer={
          <>
            <AuthFooterLink href="/forgot">Forgot your password?</AuthFooterLink>
            <br />
            No account yet?{" "}
            <AuthFooterLink href={`/signup${nextQuery(next)}`}>Create one</AuthFooterLink>.
          </>
        }
      />
    </>
  );
}
