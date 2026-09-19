import { redirect } from "next/navigation";
import Link from "next/link";
import { currentViewer } from "@/lib/auth";
import { logoutAction, toggleAlertEmailsAction } from "@/lib/actions";
import { billingEnabled } from "@/lib/stripe";
import { emailEnabled } from "@/lib/email";
import { listWatched } from "@/lib/catalogues";
import { recentForAccount } from "@/lib/audit";
import { PortalButton } from "@/components/BillingButtons";
import { Card, Note } from "@/components/ui";

export const metadata = { title: "Account" };
export const dynamic = "force-dynamic";

const EVENT_LABEL: Record<string, string> = {
  signup: "Account created",
  signin: "Signed in",
  signin_failed: "Failed sign-in",
  signin_throttled: "Sign-in blocked — too many attempts",
  signout: "Signed out",
  password_reset_requested: "Password reset requested",
  password_reset_completed: "Password changed",
  email_verified: "Email confirmed",
  catalogue_saved: "Catalogue saved",
  catalogue_deleted: "Catalogue deleted",
  catalogue_exported: "Catalogue exported",
  alert_emails_changed: "Alert emails changed",
  plan_changed: "Plan changed",
};

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string }>;
}) {
  const viewer = await currentViewer();
  if (!viewer) redirect("/login");
  const { checkout } = await searchParams;
  const { account, subscription, plan } = viewer;
  const paymentConfirmed =
    plan.id !== "free" &&
    (subscription.status === "active" || subscription.status === "trialing");
  const alertEmailsOn = account.alert_emails !== 0;
  const watchedCount = (await listWatched(account.id)).length;
  const activity = await recentForAccount(account.id, 10);

  const renews = subscription.current_period_end
    ? new Date(subscription.current_period_end).toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : null;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1.5">
          <h1 className="serif text-3xl tracking-tight">Account</h1>
          <p className="text-[14px] text-muted">{account.email}</p>
        </div>
        <form action={logoutAction}>
          <button className="px-3 py-2 text-[14px] border border-rule text-muted">
            Sign out
          </button>
        </form>
      </div>

      {checkout === "done" ? (
        // The query string only says the visitor came back from Stripe. A
        // payment is confirmed when this account's subscription is active on
        // a paid plan, which is set by Stripe's webhook, not by this URL.
        paymentConfirmed ? (
          <p
            role="status"
            className="border-l-2 py-2 pl-3 text-[14px] border-accent bg-accent-soft text-accent"
          >
            Payment confirmed. Your {plan.name} plan is active.
          </p>
        ) : (
          <p
            role="status"
            className="border-l-2 py-2 pl-3 text-[14px] border-caution bg-caution-soft text-caution-ink"
          >
            Confirming your payment with Stripe — this can take a minute.
            Reload this page to check. If the plan below still says Free after
            a few minutes, write to hello@htsdesk.com.
          </p>
        )
      ) : null}

      <div className="grid gap-5 md:grid-cols-3">
        <Card>
          <div className="lbl">Plan</div>
          <div className="mt-1 text-2xl font-semibold">{plan.name}</div>
          <div className="mt-1 text-[13px] text-faint">
            {plan.priceMonthly > 0
              ? `$${plan.priceMonthly.toLocaleString()}/month`
              : "no card"}
          </div>
        </Card>
        <Card>
          <div className="lbl">Catalogue ceiling</div>
          <div className="mono mt-1 text-2xl font-semibold">
            {plan.skus.toLocaleString()}
          </div>
          <div className="mt-1 text-[13px] text-faint">products per audit</div>
        </Card>
        <Card>
          <div className="lbl">Status</div>
          <div className="mt-1 text-2xl font-semibold">
            {subscription.status === "active" && plan.id === "free"
              ? "Free"
              : subscription.status}
          </div>
          <div className="mt-1 text-[13px] text-faint">
            {renews ? `renews ${renews}` : "no renewal scheduled"}
          </div>
        </Card>
      </div>

      {subscription.status === "past_due" ||
      subscription.status === "unpaid" ? (
        <Note>
          Your last payment did not go through, so the account is on free limits
          for now. Update the card in the billing portal and the plan comes
          straight back.
        </Note>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        {subscription.stripe_customer_id && billingEnabled() ? (
          <PortalButton />
        ) : null}
        <Link
          href="/pricing"
          className="px-4 py-2 text-[14px] font-medium border border-rule"
        >
          {plan.id === "free" ? "See plans" : "Change plan"}
        </Link>
        <Link
          href="/audit"
          className="px-4 py-2 text-[14px] font-medium bg-accent text-on-accent"
        >
          Audit a catalogue
        </Link>
      </div>

      <div className="space-y-3 border-t pt-6 border-border">
        <h2 className="text-[15px] font-semibold">Alert emails</h2>
        <p className="text-[14px] text-muted">
          {plan.monitoring
            ? `We email you when a tariff action names one of the ${watchedCount.toLocaleString()} codes you watch.`
            : "Alerts appear in the app on every plan. Emailing them is part of Starter and above."}
          {plan.monitoring && !emailEnabled()
            ? " Sending is not switched on yet, so alerts are in-app only for now."
            : ""}
        </p>
        <form action={toggleAlertEmailsAction}>
          <input type="hidden" name="on" value={alertEmailsOn ? "1" : "0"} />
          <button
            className="px-4 py-2 text-[14px] font-medium"
            style={
              alertEmailsOn
                ? { border: "1px solid var(--rule)", color: "var(--muted)" }
                : { background: "var(--accent)", color: "var(--on-accent)" }
            }
          >
            {alertEmailsOn ? "Turn alert emails off" : "Turn alert emails on"}
          </button>
        </form>
      </div>

      <div className="space-y-3 border-t pt-6 border-border">
        <h2 className="text-[15px] font-semibold">Recent activity</h2>
        <p className="text-[13px] text-faint">
          Sign-ins and changes to your account. If you see something you did not
          do, reset your password — that signs out every other device.
        </p>
        <div className="scroll-x">
          <table className="w-full min-w-[420px] text-[13px]">
            <tbody>
              {activity.length === 0 ? (
                <tr>
                  <td className="py-2 text-faint">Nothing recorded yet.</td>
                </tr>
              ) : (
                activity.map((row) => (
                  <tr key={row.id} className="border-b border-hair">
                    <td className="mono nb py-2 pr-4 text-faint">
                      {new Date(row.at).toLocaleString("en-US", {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </td>
                    <td className="py-2 pr-4">
                      {EVENT_LABEL[row.event] ?? row.event}
                    </td>
                    <td className="mono py-2 text-[12px] text-faint">
                      {row.client ?? ""}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="space-y-2 border-t pt-6 border-border">
        <h2 className="text-[15px] font-semibold">What your plan buys</h2>
        <ul className="grid gap-1.5 text-[14px] sm:grid-cols-2 text-muted">
          {plan.features.map((f) => (
            <li key={f}>· {f}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
