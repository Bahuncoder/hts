import { redirect } from "next/navigation";
import { AuthForm, AuthFooterLink } from "@/components/AuthForm";
import { signUpAction } from "@/lib/actions";
import { currentViewer } from "@/lib/auth";

export const metadata = { title: "Create an account" };

export default async function SignUpPage() {
  if (await currentViewer()) redirect("/account");
  return (
    <AuthForm
      action={signUpAction}
      submit="Create account"
      heading="Create an account"
      blurb="Classify 25 products free. No card until you need more."
      footer={<>Already have one? <AuthFooterLink href="/login">Sign in</AuthFooterLink>.</>}
    />
  );
}
