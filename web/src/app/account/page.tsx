import Link from "next/link";
import { requireViewer } from "@/lib/auth";
import { toggleAlertEmailsAction } from "@/lib/actions";
import { AccountDraftBanner, SignOutForm } from "@/components/DraftNotice";
import { emailEnabled } from "@/lib/email";
import { listCatalogues, listWatched } from "@/lib/catalogues";
import { recentForAccount } from "@/lib/audit";
import { PLAN_COPY, PLAN_PRICE_MONTHLY, windowLabel } from "@/lib/plans";
import { billingEnabled } from "@/lib/stripe";
import { subscriptionFor } from "@/lib/store";
import { PortalButton } from "@/components/BillingButtons";
import { ThemeSelect } from "@/components/ThemeSelect";
import SettingsNav from "@/components/SettingsNav";

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
  api_key_created: "API key created",
  api_key_revoked: "API key revoked",
};

export default async function AccountPage() {
  const viewer = await requireViewer("/account");
  const { account, limits, plan } = viewer;
  const alertEmailsOn = account.alert_emails !== 0;
  const watchedCount = (await listWatched(account.id)).length;
  const catalogues = await listCatalogues(account.id);
  const needing = catalogues.filter((c) => c.needs_review > 0);
  const activity = await recentForAccount(account.id, 10);
  const hasCustomer = billingEnabled() && Boolean((await subscriptionFor(account.id)).stripe_customer_id);

  return (
    <div className="settings-page">
      <div className="settings-heading">
        <div><h1 className="serif text-3xl tracking-tight">Account settings</h1><p className="mt-2 text-[15px] text-muted">Manage your plan, preferences, and account.</p></div>
      </div>
      <AccountDraftBanner />
      <div className="settings-layout">
        <SettingsNav sections={[
          { id: "profile", label: "Profile" },
          { id: "plan", label: "Plan and limits" },
          { id: "preferences", label: "Preferences" },
          { id: "security", label: "Security and activity" },
        ]} />
        <div id="settings-sections" className="settings-content">
          <section id="profile" className="settings-panel" aria-labelledby="profile-title">
            <div className="settings-section-heading"><h2 id="profile-title">Profile</h2><p>Your sign-in email and saved work.</p></div>
            <div className="settings-row"><div><p className="settings-label">Email address</p><p className="mt-1 break-all text-[15px]">{account.email}</p></div></div>
            <div className="settings-row"><div><p className="settings-label">Your work</p><p className="mt-1 text-[14px] text-muted">{catalogues.length.toLocaleString()} saved catalogues · {needing.length.toLocaleString()} with estimates needing attention</p></div><Link href="/catalogues" className="btn btn-secondary">Open catalogues</Link></div>
            {needing.length > 0 && <ul className="settings-work-list">{needing.slice(0, 5).map((c) => <li key={c.id}><div><p className="text-[14px] font-medium">{c.name}</p><p className="text-[13px] text-muted">{c.needs_review.toLocaleString()} products need attention</p></div><Link href={`/catalogues/${c.id}/review`} className="text-[14px] font-medium text-accent">Continue review →</Link></li>)}</ul>}
          </section>
          <section id="plan" className="settings-panel" aria-labelledby="plan-title">
            <div className="settings-section-heading"><h2 id="plan-title">Plan and limits</h2><p>Your current subscription and included allowances.</p></div>
            <div className="settings-row"><div><p className="text-[18px] font-semibold">{PLAN_COPY[plan].name}{" "}<span className="ml-2 text-[14px] font-normal text-muted">{PLAN_PRICE_MONTHLY[plan] > 0 ? `$${PLAN_PRICE_MONTHLY[plan].toLocaleString()}/month` : "No subscription charge"}</span></p><p className="mt-1 text-[14px] text-muted">{PLAN_COPY[plan].blurb}</p></div><div className="flex flex-wrap gap-2">{hasCustomer && <PortalButton />}<Link href="/pricing" className="btn btn-secondary">{plan === "free" ? "Explore plans" : "Change plan"}</Link></div></div>
            <dl className="settings-limits">{[
              ["Products per audit", limits.productsPerAudit],
              [`Audits per ${windowLabel(limits.auditRequests.windowMs)}`, limits.auditRequests.max],
              ["Products per rolling 24 hours", limits.itemsPerDay.max],
              ["Saved catalogues", limits.savedCatalogues],
            ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd className="mono">{value.toLocaleString()}</dd></div>)}</dl>
            <div className="settings-row"><div><p className="settings-label">API access</p><p className="mt-1 text-[13px] text-muted">{limits.api.enabled ? `${limits.api.itemsPerDay.max.toLocaleString()} products a day · ${limits.api.requests.max} requests/minute` : "Available on Starter and Growth"}</p></div>{limits.api.enabled && <Link href="/account/api-keys" className="btn btn-secondary">Manage API keys</Link>}</div>
            <div className="settings-row"><div><p className="settings-label">Entry Refund Check</p><p className="mt-1 text-[13px] text-muted">{limits.refundCheck.enabled ? "Included in your plan" : "Available on Starter and Growth"}</p></div>{limits.refundCheck.enabled && <Link href="/refund-check" className="btn btn-secondary">Run a check</Link>}</div>
          </section>
          <section id="preferences" className="settings-panel" aria-labelledby="preferences-title">
            <div className="settings-section-heading"><h2 id="preferences-title">Preferences</h2><p>Choose how HTSDesk looks and keeps you informed.</p></div>
            <div className="settings-preference"><div><p className="settings-label">Appearance</p><p className="mt-1 text-[13px] text-muted">Saved on this device. System follows your device settings.</p></div><ThemeSelect variant="choices" /></div>
            <div className="settings-row"><div className="max-w-lg"><p className="settings-label">Tariff alert emails <span className="ml-2 text-[12px] font-normal text-muted">{alertEmailsOn ? "On" : "Off"}</span></p><p className="mt-1 text-[14px] text-muted">{alertEmailsOn ? `Receive notices that name the ${watchedCount.toLocaleString()} codes you watch.` : "Alerts still appear in the app when emails are off."}</p>{alertEmailsOn && !emailEnabled() && <p className="mt-2 text-[13px] text-caution-ink">Email delivery is currently unavailable. Check alerts in the app.</p>}</div><form action={toggleAlertEmailsAction}><input type="hidden" name="on" value={alertEmailsOn ? "1" : "0"} /><button className="btn btn-secondary">{alertEmailsOn ? "Turn alert emails off" : "Turn alert emails on"}</button></form></div>
          </section>
          <section id="security" className="settings-panel" aria-labelledby="security-title">
            <div className="settings-section-heading"><h2 id="security-title">Security and activity</h2><p>Review sign-ins and changes to your account.</p></div>
            <div className="settings-row"><div><p className="settings-label">This device</p><p className="mt-1 text-[14px] text-muted">Ends your session in this browser.</p></div><SignOutForm /></div>
            <div className="settings-row"><div><p className="settings-label">Password recovery</p><p className="mt-1 max-w-lg text-[14px] text-muted">Request an email to reset your password. Completing a reset signs out other devices.</p></div><Link href="/forgot" className="btn btn-secondary">Reset password</Link></div>
            <div className="settings-activity"><h3 className="settings-label">Recent activity</h3>{activity.length === 0 ? <p className="mt-3 text-[14px] text-muted">No recent activity recorded.</p> : <ul>{activity.map((row) => <li key={row.id}><div><p className="text-[14px]">{EVENT_LABEL[row.event] ?? row.event}</p>{row.client && <p className="mt-1 break-all text-[12px] text-muted">{row.client}</p>}</div><time dateTime={row.at} className="text-[12px] text-muted">{new Date(row.at).toLocaleString("en-US", {month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC"})} UTC</time></li>)}</ul>}</div>
          </section>
        </div>
      </div>
    </div>
  );
}
