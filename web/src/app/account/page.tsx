import { redirect } from "next/navigation";
import Link from "next/link";
import { currentViewer } from "@/lib/auth";
import { logoutAction, toggleAlertEmailsAction } from "@/lib/actions";
import { billingEnabled } from "@/lib/stripe";
import { emailEnabled } from "@/lib/email";
import { listWatched } from "@/lib/catalogues";
import { PortalButton } from "@/components/BillingButtons";
import { Card, Note } from "@/components/ui";

export const metadata = { title: "Account" };
export const dynamic = "force-dynamic";

export default async function AccountPage({
  searchParams,
}: { searchParams: Promise<{ checkout?: string }> }) {
  const viewer = await currentViewer();
  if (!viewer) redirect("/login");
  const { checkout } = await searchParams;
  const { account, subscription, plan } = viewer;
  const alertEmailsOn = account.alert_emails !== 0;
  const watchedCount = listWatched(account.id).length;

  const renews = subscription.current_period_end
    ? new Date(subscription.current_period_end).toLocaleDateString("en-US",
        { year: "numeric", month: "long", day: "numeric" })
    : null;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1.5">
          <h1 className="serif text-3xl tracking-tight">Account</h1>
          <p className="text-[14px]" style={{ color: "var(--muted)" }}>{account.email}</p>
        </div>
        <form action={logoutAction}>
          <button className="px-3 py-2 text-[14px]"
                  style={{ border: "1px solid var(--rule)", color: "var(--muted)" }}>
            Sign out
          </button>
        </form>
      </div>

      {checkout === "done" ? (
        <p className="border-l-2 py-2 pl-3 text-[14px]"
           style={{ borderColor: "var(--accent)", background: "var(--accent-soft)", color: "var(--accent)" }}>
          Payment received. If the plan below still says Free, the confirmation from
          Stripe is a moment behind — reload in a few seconds.
        </p>
      ) : null}

      <div className="grid gap-5 md:grid-cols-3">
        <Card>
          <div className="lbl">Plan</div>
          <div className="mt-1 text-2xl font-semibold">{plan.name}</div>
          <div className="mt-1 text-[13px]" style={{ color: "var(--faint)" }}>
            {plan.priceMonthly > 0 ? `$${plan.priceMonthly.toLocaleString()}/month` : "no card"}
          </div>
        </Card>
        <Card>
          <div className="lbl">Catalogue ceiling</div>
          <div className="mono mt-1 text-2xl font-semibold">{plan.skus.toLocaleString()}</div>
          <div className="mt-1 text-[13px]" style={{ color: "var(--faint)" }}>products per audit</div>
        </Card>
        <Card>
          <div className="lbl">Status</div>
          <div className="mt-1 text-2xl font-semibold">
            {subscription.status === "active" && plan.id === "free" ? "Free" : subscription.status}
          </div>
          <div className="mt-1 text-[13px]" style={{ color: "var(--faint)" }}>
            {renews ? `renews ${renews}` : "no renewal scheduled"}
          </div>
        </Card>
      </div>

      {subscription.status === "past_due" || subscription.status === "unpaid" ? (
        <Note>
          Your last payment did not go through, so the account is on free limits for
          now. Update the card in the billing portal and the plan comes straight back.
        </Note>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        {subscription.stripe_customer_id && billingEnabled() ? <PortalButton /> : null}
        <Link href="/pricing" className="px-4 py-2 text-[14px] font-medium"
              style={{ border: "1px solid var(--rule)" }}>
          {plan.id === "free" ? "See plans" : "Change plan"}
        </Link>
        <Link href="/audit" className="px-4 py-2 text-[14px] font-medium"
              style={{ background: "var(--accent)", color: "var(--on-accent)" }}>
          Audit a catalogue
        </Link>
      </div>

      <div className="space-y-3 border-t pt-6" style={{ borderColor: "var(--border)" }}>
        <h2 className="text-[15px] font-semibold">Alert emails</h2>
        <p className="text-[14px]" style={{ color: "var(--muted)" }}>
          {plan.monitoring
            ? `We email you when a tariff action names one of the ${watchedCount.toLocaleString()} codes you watch.`
            : "Alerts appear in the app on every plan. Emailing them is part of Starter and above."}
          {plan.monitoring && !emailEnabled()
            ? " Sending is not switched on yet, so alerts are in-app only for now."
            : ""}
        </p>
        <form action={toggleAlertEmailsAction}>
          <input type="hidden" name="on" value={alertEmailsOn ? "1" : "0"} />
          <button className="px-4 py-2 text-[14px] font-medium"
                  style={alertEmailsOn
                    ? { border: "1px solid var(--rule)", color: "var(--muted)" }
                    : { background: "var(--accent)", color: "var(--on-accent)" }}>
            {alertEmailsOn ? "Turn alert emails off" : "Turn alert emails on"}
          </button>
        </form>
      </div>

      <div className="space-y-2 border-t pt-6" style={{ borderColor: "var(--border)" }}>
        <h2 className="text-[15px] font-semibold">What your plan buys</h2>
        <ul className="grid gap-1.5 text-[14px] sm:grid-cols-2" style={{ color: "var(--muted)" }}>
          {plan.features.map((f) => <li key={f}>· {f}</li>)}
        </ul>
      </div>
    </div>
  );
}
