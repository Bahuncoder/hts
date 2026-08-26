import { redirect } from "next/navigation";
import { AuthForm, AuthFooterLink } from "@/components/AuthForm";
import { signUpAction } from "@/lib/actions";
import { currentViewer } from "@/lib/auth";

export const metadata = { title: "Create an account" };
export const dynamic = "force-dynamic";

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ verify?: string }>;
}) {
  if (await currentViewer()) redirect("/account");
  const { verify } = await searchParams;
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
        heading="Create an account"
        blurb="Classify 25 products free. No card until you need more."
        footer={
          <>
            Already have one?{" "}
            <AuthFooterLink href="/login">Sign in</AuthFooterLink>.
          </>
        }
      />
    </>
  );
}
