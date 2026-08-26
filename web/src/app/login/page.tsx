import { redirect } from "next/navigation";
import { AuthForm, AuthFooterLink } from "@/components/AuthForm";
import { loginAction } from "@/lib/actions";
import { currentViewer } from "@/lib/auth";

export const metadata = { title: "Sign in" };

export default async function LoginPage() {
  if (await currentViewer()) redirect("/account");
  return (
    <AuthForm
      action={loginAction}
      submit="Sign in"
      heading="Sign in"
      blurb="Your catalogues and watched codes are waiting."
      footer={
        <>
          <AuthFooterLink href="/forgot">Forgot your password?</AuthFooterLink>
          <br />
          No account yet? <AuthFooterLink href="/signup">Create one</AuthFooterLink>.
        </>
      }
    />
  );
}
