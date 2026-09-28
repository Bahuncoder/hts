import { redirect } from "next/navigation";
import Link from "next/link";
import { currentViewer } from "@/lib/auth";
import { toggleAlertEmailsAction } from "@/lib/actions";
import { AccountDraftBanner, SignOutForm } from "@/components/DraftNotice";
import { emailEnabled } from "@/lib/email";
import { listWatched } from "@/lib/catalogues";
import { recentForAccount } from "@/lib/audit";
import { Card } from "@/components/ui";
import { windowLabel } from "@/lib/plans";

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
};

export default async function AccountPage() {
  const viewer = await currentViewer();
  if (!viewer) redirect("/login");
  const { account, limits } = viewer;
  const alertEmailsOn = account.alert_emails !== 0;
  const watchedCount = (await listWatched(account.id)).length;
  const activity = await recentForAccount(account.id, 10);

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1.5">
          <h1 className="serif text-3xl tracking-tight">Account</h1>
          <p className="text-[14px] text-muted">{account.email}</p>
        </div>
        <SignOutForm />
      </div>

      <AccountDraftBanner />

      <div className="space-y-3">
        <div>
          <h2 className="text-[15px] font-semibold">Your allowance</h2>
          <p className="mt-1 text-[14px] text-muted">
            HTSDesk is free while it is in beta. These limits keep it fast for
            everyone, and they may change.
          </p>
        </div>
        <div className="grid gap-5 sm:grid-cols-2 md:grid-cols-4">
          <Card>
            <div className="lbl">Products per audit</div>
            <div className="mono mt-1 text-2xl font-semibold">
              {limits.productsPerAudit.toLocaleString()}
            </div>
          </Card>
          <Card>
            <div className="lbl">Audits per {windowLabel(limits.auditRequests.windowMs)}</div>
            <div className="mono mt-1 text-2xl font-semibold">
              {limits.auditRequests.max.toLocaleString()}
            </div>
          </Card>
          <Card>
            <div className="lbl">Products per day</div>
            <div className="mono mt-1 text-2xl font-semibold">
              {limits.itemsPerDay.max.toLocaleString()}
            </div>
            <div className="mt-1 text-[13px] text-faint">rolling 24 hours</div>
          </Card>
          <Card>
            <div className="lbl">Saved catalogues</div>
            <div className="mono mt-1 text-2xl font-semibold">
              {limits.savedCatalogues.toLocaleString()}
            </div>
          </Card>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
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
          {alertEmailsOn
            ? `We email you when a tariff action names one of the ${watchedCount.toLocaleString()} codes you watch.`
            : "Alert emails are off. Alerts still appear in the app."}
          {alertEmailsOn && !emailEnabled()
            ? " Sending is not switched on yet, so alerts are in-app only for now."
            : ""}
        </p>
        <form action={toggleAlertEmailsAction}>
          <input type="hidden" name="on" value={alertEmailsOn ? "1" : "0"} />
          <button className={alertEmailsOn ? "btn btn-secondary" : "btn btn-primary"}>
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
    </div>
  );
}
