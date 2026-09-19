import Link from "next/link";
import { verifyUnsubscribe } from "@/lib/email";
import { accountById, setAlertEmails } from "@/lib/store";
import { Card } from "@/components/ui";

export const metadata = {
  title: "Email preferences",
  robots: { index: false },
};
export const dynamic = "force-dynamic";

/** Unsubscribe from a link in an email.
 *
 *  Deliberately works without a session — someone who no longer wants our mail
 *  should not have to sign in to stop it. The signed token is what makes that
 *  safe.
 */
export default async function UnsubscribePage({
  searchParams,
}: {
  searchParams: Promise<{ a?: string; t?: string }>;
}) {
  const { a: accountId, t: token } = await searchParams;
  const ok = accountId && token && verifyUnsubscribe(accountId, token);
  const account = ok ? await accountById(accountId) : undefined;

  if (!ok || !account) {
    return (
      <div className="mx-auto max-w-[560px] space-y-4 py-4">
        <h1 className="serif text-3xl tracking-tight">
          That link did not work
        </h1>
        <p className="text-[15px] text-muted">
          It may have been truncated by an email client. You can turn alert
          emails off from your{" "}
          <Link href="/account" className="hover:underline text-accent">
            account
          </Link>{" "}
          instead.
        </p>
      </div>
    );
  }

  await setAlertEmails(accountId, false);

  return (
    <div className="mx-auto max-w-[560px] space-y-5 py-4">
      <h1 className="serif text-3xl tracking-tight">Alert emails are off</h1>
      <Card>
        <p className="text-[15px] text-muted">
          We will not email <span className="mono">{account.email}</span> about
          tariff actions again.
        </p>
        <p className="mt-3 text-[15px] text-muted">
          Your watched codes are untouched and alerts still appear in{" "}
          <Link href="/alerts" className="hover:underline text-accent">
            the app
          </Link>
          . You can turn emails back on from your account at any time.
        </p>
      </Card>
    </div>
  );
}
