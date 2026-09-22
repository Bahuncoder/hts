import { redirect } from "next/navigation";
import { AuthForm, AuthFooterLink } from "@/components/AuthForm";
import { signUpAction } from "@/lib/actions";
import { currentViewer } from "@/lib/auth";
import { googleEnabled } from "@/lib/googleAuth";
import { nextQuery, safeNext } from "@/lib/next";

export const metadata = { title: "Create an account" };
export const dynamic = "force-dynamic";

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ verify?: string; next?: string | string[] }>;
}) {
  const { verify, next: rawNext } = await searchParams;
  const next = safeNext(rawNext);
  if (await currentViewer()) redirect(next ?? "/account");
  return (
    <>
      {verify === "expired" ? (
        <p className="mx-auto mt-8 max-w-[400px] border-l-2 py-2 pl-3 text-[13px] border-caution bg-caution-soft text-caution-ink">
          That confirmation link had expired or had already been used. Sign up
          again and we will send a fresh one.
        </p>
      ) : null}
      <AuthForm
        action={signUpAction}
        submit="Create account"
        newPassword
        hidden={next ? { next } : undefined}
        googleHref={googleEnabled() ? `/api/auth/google${nextQuery(next)}` : undefined}
        heading="Create an account"
        blurb="Free. Classify and price up to 200 products at a time."
        footer={
          <>
            Already have one?{" "}
            <AuthFooterLink href={`/login${nextQuery(next)}`}>Sign in</AuthFooterLink>.
          </>
        }
      />
    </>
  );
}
