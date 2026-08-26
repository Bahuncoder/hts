import { AuthForm, AuthFooterLink } from "@/components/AuthForm";
import { requestResetAction } from "@/lib/actions";

export const metadata = { title: "Reset your password", robots: { index: false } };

export default function ForgotPage() {
  return (
    <AuthForm
      action={requestResetAction}
      submit="Send a reset link"
      heading="Reset your password"
      blurb="We will email you a link. It works once, and expires in an hour."
      emailOnly
      footer={<>Remembered it? <AuthFooterLink href="/login">Sign in</AuthFooterLink>.</>}
    />
  );
}
