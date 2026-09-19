import Link from "next/link";
import { AuthForm, AuthFooterLink } from "@/components/AuthForm";
import { completeResetAction } from "@/lib/actions";
import { peek } from "@/lib/tokens";

export const metadata = {
  title: "Set a new password",
  robots: { index: false },
};
export const dynamic = "force-dynamic";

export default async function ResetPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  if (!token || !(await peek("password_reset", token))) {
    return (
      <div className="mx-auto max-w-[400px] space-y-4 py-8">
        <h1 className="serif text-3xl tracking-tight">
          That link is no longer valid
        </h1>
        <p className="text-[15px] text-muted">
          Reset links work once and expire after an hour.{" "}
          <Link href="/forgot" className="hover:underline text-accent">
            Ask for a new one
          </Link>
          .
        </p>
      </div>
    );
  }

  return (
    <AuthForm
      action={completeResetAction}
      submit="Set new password"
      heading="Set a new password"
      blurb="Choosing a new password signs out every other device."
      hidden={{ token }}
      newPassword
      footer={
        <>
          <AuthFooterLink href="/login">Back to sign in</AuthFooterLink>.
        </>
      }
    />
  );
}
